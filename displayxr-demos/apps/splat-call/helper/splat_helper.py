#!/usr/bin/env python3
"""Splat Call helper: on-device and cloud models the browser can't run by itself.

Runs on the same PC as the browser, at http://127.0.0.1:8830, and serves the Splat Call page:

  GET  /health                 what is available
  GET  /sharp/load             start loading SHARP (downloading it on first use)
  POST /sharp?w=&h=&f=&keep=   Apple SHARP: one RGB frame (1536x1536x3 bytes, already resized by
                               the page) -> up to ~1.2M 3D Gaussians, metric, camera space
  POST /immersity/disparity    Immersity AI (Leia) cloud disparity: one JPEG -> float32 disparity

SHARP ("Sharp Monocular View Synthesis in Less Than a Second", Apple, 2025) is far too big for a
browser (1.3 GB fp16), so it runs here through ONNX Runtime + DirectML, which works on any
DirectX 12 GPU without CUDA. The weights are the community fp16 ONNX export of Apple's checkpoint
(huggingface.co/pearsonkyle/Sharp-onnx), downloaded on first use (needs ~1.5 GB free). Apple's
model licence is RESEARCH ONLY (non-commercial).

Immersity AI needs IMMERSITY_CLIENT_ID and IMMERSITY_CLIENT_SECRET (displayxr-demos/.env or the
environment). Every call costs credits.

    python splat_helper.py [--port 8830] [--model PATH] [--cpu] [--preload]
                           [--mock-sharp] [--mock-immersity]

The --mock-* flags serve fake results so the page can be tested without the model or keys.
Needs: pip install onnxruntime-directml numpy pillow   (plain onnxruntime on macOS / Linux)
"""

from __future__ import annotations

import argparse
import io
import json
import os
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import numpy as np

VERSION = 1
SHARP_URL = 'https://huggingface.co/pearsonkyle/Sharp-onnx/resolve/main/sharp_fp16.onnx'
SHARP_BYTES = 1_319_661_752
SHARP_SIZE = 1536
DEFAULT_MODEL = Path.home() / '.cache' / 'splat-call' / 'sharp_fp16.onnx'
IMMERSITY_TOKEN_URL = 'https://auth.immersity.ai/auth/realms/immersity/protocol/openid-connect/token'
IMMERSITY_API = 'https://api.immersity.ai/api/v1'
ALLOWED_ORIGINS = {'https://joehillthunder.github.io'}


def log(*a):
    print(time.strftime('%H:%M:%S'), *a, flush=True)


def load_env():
    """KEY=value lines from the nearest .env above this file (environment variables win)."""
    for d in Path(__file__).resolve().parents:
        f = d / '.env'
        if f.is_file():
            for line in f.read_text(encoding='utf-8').splitlines():
                line = line.strip()
                if line and not line.startswith('#') and '=' in line:
                    k, v = line.split('=', 1)
                    os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))
            return f
    return None


# ------------------------------------------------------------------------------------------------
# SHARP


def quat_cov(quats, scales, a):
    """Covariances A R diag(s^2) R^T A (A = diag(a)) from wxyz quaternions, as 6 floats in mm^2."""
    q = quats / np.linalg.norm(quats, axis=1, keepdims=True).clip(1e-8)
    w, x, y, z = q[:, 0], q[:, 1], q[:, 2], q[:, 3]
    R = np.stack([
        1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y),
        2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
        2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y),
    ], axis=1).reshape(-1, 3, 3)
    M = R * scales[:, None, :] * a[None, :, None]
    cov = M @ M.transpose(0, 2, 1)
    return np.stack([cov[:, 0, 0], cov[:, 0, 1], cov[:, 0, 2], cov[:, 1, 1], cov[:, 1, 2], cov[:, 2, 2]], 1) * 1e6


class Sharp:
    def __init__(self, path: Path, cpu: bool, mock: bool):
        self.path = path
        self.cpu = cpu
        self.mock = mock
        self.session = None
        self.provider = 'mock' if mock else ''
        self.error = ''
        self.state = 'ready' if mock else 'idle'  # idle | downloading | loading | ready | error
        self.progress = 0.0
        self.lock = threading.Lock()

    def status(self):
        return {'state': self.state, 'provider': self.provider, 'progress': round(self.progress, 3), 'error': self.error,
                'mock': self.mock, 'downloaded': self.mock or self.path.is_file()}

    def ensure(self):
        """Download (first run) and load the model. Thread-safe; blocks until ready or failed."""
        if self.mock:
            return
        with self.lock:
            if self.session is not None:
                return
            try:
                if not self.path.is_file():
                    self.download()
                self.state = 'loading'
                import onnxruntime as ort
                opts = ort.SessionOptions()
                opts.log_severity_level = 3
                providers = ['CPUExecutionProvider']
                if not self.cpu and 'DmlExecutionProvider' in ort.get_available_providers():
                    providers.insert(0, 'DmlExecutionProvider')
                    opts.enable_mem_pattern = False  # DirectML requires both of these
                    opts.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
                t = time.time()
                try:
                    self.session = ort.InferenceSession(str(self.path), opts, providers=providers)
                except Exception as e:  # noqa: BLE001 - a GPU that can't take the graph: use the CPU
                    if len(providers) == 1:
                        raise
                    log('DirectML could not load SHARP, using the CPU (slow):', e)
                    self.session = ort.InferenceSession(str(self.path), ort.SessionOptions(), providers=['CPUExecutionProvider'])
                self.provider = self.session.get_providers()[0]
                self.inputs = {i.name: i for i in self.session.get_inputs()}
                log(f'SHARP loaded on {self.provider} in {time.time() - t:.1f} s')
                self.state = 'ready'
                self.error = ''
            except Exception as e:  # noqa: BLE001 - reported to the page
                self.state = 'error'
                self.error = str(e)
                log('SHARP failed:', e)
                raise

    def download(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        free = __import__('shutil').disk_usage(self.path.parent).free
        if free < SHARP_BYTES + (300 << 20):
            raise RuntimeError(f'not enough disk space for SHARP: it needs 1.6 GB free, and {free / 2**30:.1f} GB is')
        self.state = 'downloading'
        part = self.path.with_suffix('.part')
        log(f'downloading SHARP (1.3 GB) to {self.path}')
        try:
            with urllib.request.urlopen(SHARP_URL) as r, open(part, 'wb') as out:
                total = int(r.headers.get('Content-Length') or SHARP_BYTES)
                done = 0
                while chunk := r.read(1 << 20):
                    out.write(chunk)
                    done += len(chunk)
                    self.progress = done / total
            part.replace(self.path)
        except BaseException:
            part.unlink(missing_ok=True)  # never leave a partial 1 GB file behind
            raise

    def predict(self, rgb: np.ndarray, W: int, H: int, f: float, keep: int):
        """rgb: SHARP_SIZE^2 x 3 uint8, the W x H frame resized without keeping the aspect (as
        Apple's predict_image does). f: focal length in source pixels. Returns camera-space
        (OpenCV: x right, y down, z forward, metres) means, covariances (mm^2), sRGB + alpha."""
        if self.mock:
            return self._mock(rgb, W, H, f)
        self.ensure()
        img = (rgb.astype(np.float32) / 255.0).transpose(2, 0, 1)[None]
        feeds = {'image': img, 'disparity_factor': np.array([f / W], np.float32)}
        for name, i in self.inputs.items():
            if 'float16' in i.type:
                feeds[name] = feeds[name].astype(np.float16)
        t = time.time()
        outs = self.session.run(None, feeds)
        infer_ms = (time.time() - t) * 1000
        if len(outs) == 1:
            c = outs[0][0].astype(np.float32)
            means, scales, quats, colors, alpha = c[:, 0:3], c[:, 3:6], c[:, 6:10], c[:, 10:13], c[:, 13]
        else:
            means, scales, quats, colors, alpha = (o[0].astype(np.float32) for o in outs[:5])
            alpha = alpha.reshape(-1)
        t = time.time()
        ok = alpha > 0.02
        means, scales, quats, colors, alpha = means[ok], scales[ok], quats[ok], colors[ok], alpha[ok]
        if keep and len(alpha) > keep:
            importance = alpha * np.sqrt(scales[:, 0] * scales[:, 1] + 1e-12)
            idx = np.argpartition(-importance, keep)[:keep]
            means, scales, quats, colors, alpha = means[idx], scales[idx], quats[idx], colors[idx], alpha[idx]
        # NDC -> camera, as Apple's unproject_gaussians with identity extrinsics: the linear map
        # A = diag(W/2f, H/2f, 1) on the means, and A S A^T on the covariances.
        a = np.array([W / (2 * f), H / (2 * f), 1.0], np.float32)
        means = means * a
        cov6 = quat_cov(quats, scales, a)
        lin = colors.clip(0, 1)
        srgb = np.where(lin <= 0.0031308, lin * 12.92, 1.055 * np.power(lin, 1 / 2.4) - 0.055)
        rgba = (np.concatenate([srgb, alpha[:, None]], 1).clip(0, 1) * 255 + 0.5).astype(np.uint8)
        post_ms = (time.time() - t) * 1000
        return means.astype(np.float32), cov6.astype(np.float32), rgba, infer_ms, post_ms

    def _mock(self, rgb, W, H, f):
        """A fake SHARP for testing: a relief surface from luminance, one splat per 3x3 pixels."""
        t = time.time()
        g = rgb[::3, ::3].astype(np.float32) / 255.0
        h, w = g.shape[:2]
        lum = g.mean(2)
        v, u = np.mgrid[0:h, 0:w].astype(np.float32)
        px, py = (u + 0.5) / w * W, (v + 0.5) / h * H
        r = np.hypot((px - W / 2) / W, (py - H * 0.45) / H)
        z = 0.75 + 0.6 * r + 0.08 * (1 - lum)
        x, y = (px - W / 2) / f * z, (py - H / 2) / f * z
        means = np.stack([x, y, z], -1).reshape(-1, 3)
        s = (z * (W / w) / f * 0.7).reshape(-1)
        cov6 = np.zeros((len(s), 6), np.float32)
        cov6[:, 0] = cov6[:, 3] = (s * s) * 1e6
        cov6[:, 5] = (s * s * 0.1) * 1e6
        rgba = np.concatenate([g.reshape(-1, 3), np.ones((len(s), 1), np.float32)], 1)
        rgba = (rgba * 255).astype(np.uint8)
        time.sleep(0.3)
        return means.astype(np.float32), cov6, rgba, (time.time() - t) * 1000, 0.0


# ------------------------------------------------------------------------------------------------
# Immersity AI


class Immersity:
    def __init__(self, mock: bool):
        self.mock = mock
        self.token = ''
        self.token_exp = 0.0

    @property
    def configured(self):
        return bool(os.environ.get('IMMERSITY_CLIENT_ID') and os.environ.get('IMMERSITY_CLIENT_SECRET'))

    def status(self):
        return {'configured': self.configured, 'mock': self.mock}

    def _req(self, url, data=None, headers=None, method=None, timeout=120):
        req = urllib.request.Request(url, data=data, headers=headers or {}, method=method)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read(), r.headers
        except urllib.error.HTTPError as e:
            body = e.read()[:300].decode('utf-8', 'replace')
            hint = ' (out of credits)' if e.code == 402 else ' (check the client id and secret)' if e.code == 401 else ''
            raise RuntimeError(f'Immersity {e.code}{hint}: {body}') from None

    def _auth(self):
        if self.token and time.time() < self.token_exp - 60:
            return self.token
        body = urllib.parse.urlencode({
            'client_id': os.environ['IMMERSITY_CLIENT_ID'],
            'client_secret': os.environ['IMMERSITY_CLIENT_SECRET'],
            'grant_type': 'client_credentials',
        }).encode()
        raw, _ = self._req(IMMERSITY_TOKEN_URL, body, {'Content-Type': 'application/x-www-form-urlencoded'})
        tok = json.loads(raw)
        self.token = tok['access_token']
        self.token_exp = time.time() + float(tok.get('expires_in', 300))
        return self.token

    def disparity(self, jpeg: bytes):
        """JPEG in -> (float32 disparity in 0..1, larger = nearer, w, h)."""
        from PIL import Image
        if self.mock:
            return self._mock(jpeg)
        if not self.configured:
            raise RuntimeError('Immersity AI is not set up: add IMMERSITY_CLIENT_ID and IMMERSITY_CLIENT_SECRET to displayxr-demos/.env')
        auth = {'Authorization': f'Bearer {self._auth()}'}
        cid = str(uuid.uuid4())
        # 1. Upload the frame to Leia storage through a presigned PUT URL (valid 24 h).
        q = urllib.parse.urlencode({'fileName': f'{cid}.jpg', 'mediaType': 'image/jpeg', 'correlationId': cid})
        raw, _ = self._req(f'{IMMERSITY_API}/get-upload-url?{q}', headers=auth)
        put_url = json.loads(raw)['url']
        self._req(put_url, jpeg, {'Content-Type': 'image/jpeg'}, method='PUT')
        # 2. Disparity: the service reads the upload and returns a GET URL for the 16-bit PNG.
        body = json.dumps({'correlationId': str(uuid.uuid4()), 'inputImageUrl': put_url, 'outputBitDepth': 'uint16'}).encode()
        raw, _ = self._req(f'{IMMERSITY_API}/disparity', body, {**auth, 'Content-Type': 'application/json'}, timeout=300)
        png, _ = self._req(json.loads(raw)['resultPresignedUrl'])
        im = Image.open(io.BytesIO(png))
        a = np.asarray(im).astype(np.float32)
        if a.ndim == 3:
            a = a[..., 0]
        a /= 65535.0 if a.max() > 255 else 255.0
        return a, im.width, im.height

    def _mock(self, jpeg: bytes):
        """A plausible fake (brighter and more central = nearer), for testing the pipeline only."""
        from PIL import Image, ImageFilter
        time.sleep(0.4)
        im = Image.open(io.BytesIO(jpeg)).convert('L').filter(ImageFilter.GaussianBlur(6))
        a = np.asarray(im).astype(np.float32) / 255.0
        h, w = a.shape
        yy, xx = np.mgrid[0:h, 0:w]
        r = np.hypot((xx - w / 2) / w, (yy - h * 0.45) / h)
        return (0.6 * (1 - r).clip(0, 1) + 0.4 * a).astype(np.float32), w, h


# ------------------------------------------------------------------------------------------------
# HTTP


def allowed(origin: str) -> bool:
    if origin in ALLOWED_ORIGINS:
        return True
    host = urllib.parse.urlparse(origin).hostname or ''
    return host in ('localhost', '127.0.0.1', '::1')


class Handler(BaseHTTPRequestHandler):
    server_version = 'SplatCallHelper/1'

    def log_message(self, fmt, *a):
        pass

    def cors(self):
        o = self.headers.get('Origin', '')
        if o and allowed(o):
            self.send_header('Access-Control-Allow-Origin', o)
            self.send_header('Vary', 'Origin')
            self.send_header('Access-Control-Expose-Headers', 'X-Count, X-W, X-H, X-Infer-Ms, X-Post-Ms, X-Provider')

    def reply(self, code, body: bytes, ctype='application/json', extra=None):
        self.send_response(code)
        self.cors()
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        for k, v in (extra or {}).items():
            self.send_header(k, str(v))
        self.end_headers()
        self.wfile.write(body)

    def send_json(self, code, obj):
        self.reply(code, json.dumps(obj).encode())

    def do_OPTIONS(self):
        self.send_response(204)
        self.cors()
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        # Chromium's Private/Local Network Access: a public page calling 127.0.0.1.
        self.send_header('Access-Control-Allow-Private-Network', 'true')
        self.send_header('Access-Control-Max-Age', '600')
        self.end_headers()

    def body(self):
        n = int(self.headers.get('Content-Length') or 0)
        if n > 64 << 20:
            raise ValueError('request too large')
        return self.rfile.read(n)

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        if u.path == '/health':
            return self.send_json(200, {'ok': True, 'version': VERSION, 'sharp': SHARP.status(), 'immersity': IMMERSITY.status()})
        if u.path == '/sharp/load':
            if SHARP.state in ('idle', 'error'):
                threading.Thread(target=lambda: SHARP.ensure(), daemon=True).start()
            return self.send_json(202, SHARP.status())
        self.send_json(404, {'error': 'not found'})

    def do_POST(self):
        u = urllib.parse.urlparse(self.path)
        q = {k: v[0] for k, v in urllib.parse.parse_qs(u.query).items()}
        origin = self.headers.get('Origin', '')
        if origin and not allowed(origin):
            return self.send_json(403, {'error': f'origin {origin} not allowed (use --allow-origin)'})
        try:
            if u.path == '/sharp':
                data = self.body()
                if len(data) != SHARP_SIZE * SHARP_SIZE * 3:
                    return self.send_json(400, {'error': f'expected {SHARP_SIZE}x{SHARP_SIZE} RGB bytes'})
                W, H, f = int(q['w']), int(q['h']), float(q['f'])
                keep = int(q.get('keep', 1_000_000))
                rgb = np.frombuffer(data, np.uint8).reshape(SHARP_SIZE, SHARP_SIZE, 3)
                means, cov, rgba, infer_ms, post_ms = SHARP.predict(rgb, W, H, f, keep)
                n = len(means)
                log(f'SHARP {W}x{H} f={f:.0f}: {n} splats, infer {infer_ms:.0f} ms, post {post_ms:.0f} ms')
                return self.reply(200, b''.join([means.tobytes(), cov.tobytes(), rgba.tobytes()]), 'application/octet-stream',
                                  {'X-Count': n, 'X-Infer-Ms': round(infer_ms), 'X-Post-Ms': round(post_ms), 'X-Provider': SHARP.provider})
            if u.path == '/immersity/disparity':
                t = time.time()
                disp, w, h = IMMERSITY.disparity(self.body())
                ms = (time.time() - t) * 1000
                log(f'Immersity disparity {w}x{h} in {ms:.0f} ms{" (mock)" if IMMERSITY.mock else ""}')
                return self.reply(200, disp.astype(np.float32).tobytes(), 'application/octet-stream',
                                  {'X-W': w, 'X-H': h, 'X-Infer-Ms': round(ms), 'X-Provider': 'mock' if IMMERSITY.mock else 'immersity'})
            self.send_json(404, {'error': 'not found'})
        except Exception as e:  # noqa: BLE001 - reported to the page
            log('error', u.path, e)
            self.send_json(500, {'error': str(e)})


SHARP: Sharp
IMMERSITY: Immersity


def main():
    global SHARP, IMMERSITY
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('--port', type=int, default=8830)
    p.add_argument('--model', type=Path, default=DEFAULT_MODEL, help='SHARP fp16 ONNX (downloaded on first use)')
    p.add_argument('--cpu', action='store_true', help='run SHARP on the CPU (slow)')
    p.add_argument('--preload', action='store_true', help='load SHARP at start instead of on first use')
    p.add_argument('--mock-sharp', action='store_true', help='serve fake Gaussians instead of running SHARP')
    p.add_argument('--mock-immersity', action='store_true', help='serve a fake disparity instead of calling Immersity AI')
    p.add_argument('--allow-origin', action='append', default=[], help='another page origin allowed to call the helper')
    args = p.parse_args()
    ALLOWED_ORIGINS.update(args.allow_origin)
    env = load_env()
    SHARP = Sharp(args.model, args.cpu, args.mock_sharp)
    IMMERSITY = Immersity(args.mock_immersity or os.environ.get('IMMERSITY_MOCK') == '1')
    log(f'Splat Call helper on http://127.0.0.1:{args.port}  (.env: {env or "none"})')
    log(f'  SHARP: {"mock" if SHARP.mock else args.model if args.model.is_file() else "downloads on first use (1.3 GB)"}')
    log(f'  Immersity AI: {"mock" if IMMERSITY.mock else "configured" if IMMERSITY.configured else "not configured"}')
    if args.preload:
        threading.Thread(target=SHARP.ensure, daemon=True).start()
    ThreadingHTTPServer(('127.0.0.1', args.port), Handler).serve_forever()


if __name__ == '__main__':
    sys.exit(main())
