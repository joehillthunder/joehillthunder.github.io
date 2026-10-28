# phone-3d

**3D Phone**: a phone whose screen switches between 2D and glasses-free 3D. It has five apps:
Home (layered wallpaper, floating icons), Photos (AI 2D-to-3D on one flat photo, with a scan
sweep), Game (a lane runner on a track that runs from in front of the glass into the screen),
3D Call (the caller in front of their room, buttons on the glass) and Learn (a procedural Earth
with a moon that passes in front). **Switch to 2D** flattens the whole screen onto the glass.

On a Leia display in the [DisplayXR Browser](https://github.com/DisplayXR/displayxr-browser)
the screen weaves into real depth; in any other browser it runs in 2D and follows the pointer.

**Live:** https://joehillthunder.github.io/displayxr-demos/apps/phone-3d/

Static files only: no build, no keys, no downloads (every texture is drawn in code).
Rules: [`../../CLAUDE.md`](../../CLAUDE.md) and [`CLAUDE.md`](CLAUDE.md). Branch: `app/phone-3d`.

Controls: tap the screen to use the app, drag to turn it, the dock under the phone switches
apps, and the buttons under the screen run the app's action, Switch to 2D/3D, and Home.
URL flags: `?app=photos|game|call|learn` opens an app; `?2d` forces 2D; `?debug` logs `firstWoven` and `handle.stats()`.
