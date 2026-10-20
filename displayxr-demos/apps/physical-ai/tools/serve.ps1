param([string]$Root, [string]$Out, [int]$Port = 8797)
$script:waiters = @()
$l = [System.Net.HttpListener]::new(); $l.Prefixes.Add("http://127.0.0.1:$Port/"); $l.Start()
$types = @{ '.html'='text/html'; '.js'='text/javascript'; '.mjs'='text/javascript'; '.json'='application/json'; '.png'='image/png'; '.jpg'='image/jpeg'; '.glb'='model/gltf-binary'; '.css'='text/css'; '.mp4'='video/mp4'; '.bin'='application/octet-stream'; '.hdr'='application/octet-stream'; '.wasm'='application/wasm' }
while ($l.IsListening) {
  $c = $l.GetContext(); $q = $c.Request; $r = $c.Response
  $p0 = $q.Url.AbsolutePath
  if ($p0 -eq "/__wait") { $script:waiters += ,$r; continue }
  if ($p0 -eq "/__done") { foreach ($w in $script:waiters) { try { $w.ContentType = "image/gif"; $w.Close() } catch {} }; $script:waiters = @() }
  try {
    $r.Headers.Add('Access-Control-Allow-Origin','*')
    $p = [Uri]::UnescapeDataString($q.Url.AbsolutePath)
    if ($q.HttpMethod -eq 'POST') {
      $name = $q.QueryString['name']; $f = Join-Path $Out $name
      New-Item -ItemType Directory -Force (Split-Path $f) | Out-Null
      $fs = [IO.File]::Create($f); $q.InputStream.CopyTo($fs); $fs.Close(); $r.StatusCode = 200
    } elseif ($p -eq '/__quit') { $r.Close(); $l.Stop(); break }
    else {
      $f = Join-Path $Root ($p.TrimStart('/')); if ((Test-Path $f -PathType Container)) { $f = Join-Path $f 'index.html' }
      if (Test-Path $f -PathType Leaf) { $b = [IO.File]::ReadAllBytes($f); $ext=[IO.Path]::GetExtension($f).ToLower(); $r.ContentType = $(if ($types[$ext]) { $types[$ext] } else { 'application/octet-stream' }); $r.ContentLength64 = $b.Length; $r.OutputStream.Write($b,0,$b.Length) } else { $r.StatusCode = 404 }
    }
  } catch { $r.StatusCode = 500 } finally { try { $r.Close() } catch {} }
}
