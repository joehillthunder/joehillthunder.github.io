# Asset licenses

Every asset in this repo needs a row here before it is committed. Allowed: **CC0**, **CC-BY**
(credit the author as the license requires), or **user-supplied** (the person who provided it
holds the rights and agreed to its use here). Anything else stays out of the repo.

| File | Source (URL) | Author | License | Used by |
|---|---|---|---|---|
| `apps/4dv-player/clips/cat_high_v2.*` | https://download.4dv.ai/4dv-player/web/samples/ | 4DV.ai | user-supplied (provided by Joe Hill for this demo) | 4dv-player |
| `apps/4dv-player/clips/paparazzi_mv_red.*` | https://download.4dv.ai/4dv-player/web/samples/ | 4DV.ai | user-supplied (provided by Joe Hill for this demo) | 4dv-player |
| `apps/4dv-player/clips/puppet.*` | https://download.4dv.ai/4dv-player/web/samples/ | 4DV.ai | user-supplied (provided by Joe Hill for this demo) | 4dv-player |
| `apps/physical-ai/assets/kitchen.glb` | https://huggingface.co/LightwheelAI/leisaac_env (`assets/scenes/kitchen_with_orange`), converted from USD | Lightwheel | Apache-2.0 (repo licence); includes Lightwheel SimReady fixtures ; added at the user's request | physical-ai |
| `apps/physical-ai/assets/so101.glb`, `so101-lod.glb` | https://huggingface.co/LightwheelAI/leisaac_env (`assets/robots/so101_follower.usd`), meshes simplified | Lightwheel; SO-101 design by TheRobotStudio (https://github.com/TheRobotStudio/SO-ARM100) | Apache-2.0 ; added at the user's request | physical-ai |
| `apps/physical-ai/assets/pick-orange.bin` | https://huggingface.co/datasets/LightwheelAI/leisaac-pick-orange (joint state + action, repacked) | Lightwheel | Apache-2.0 ; added at the user's request | physical-ai |
| `apps/physical-ai/tools/usdlib/*` | three.js 0.186.1 `examples/jsm/loaders/USDLoader.js` + `usd/*`, locally patched | three.js authors | MIT | physical-ai (conversion only) |

## Streamed from their source, not hosted here

Linked content the page fetches at run time from its public host (CORS). None of it is committed to this repo.

| Content | Source (URL) | Author | License | Used by |
|---|---|---|---|---|
| 4DV.ai showcase (17 clips, `group: "4DV.ai showcase · streamed"` in `apps/4dv-player/clips/clips.json`) | https://www.4dv.ai/viewer/ (files on https://s1.4dv.ai) | 4DV.ai | © 4DV.ai; their public showcase, streamed from their CDN and credited, added at the user's request | 4dv-player |
| Sear Steak (`sear.splatv`) | https://huggingface.co/cakewalk/splat-data | Meta Reality Labs, Neural 3D Video dataset; trained with Spacetime Gaussians; converted by Kevin Kwok (splaTV) | CC BY-NC 4.0 (dataset) | 4dv-player |
| Flames (`flame.splatv`) | https://huggingface.co/cakewalk/splat-data | Google, Immersive Light Field Video (DeepView Video) "02_Flames"; Spacetime Gaussians; splaTV | no licence stated by the dataset; added at the user's request, check before commercial use | 4dv-player |
| Birthday (`birthday.splatv`) | https://huggingface.co/cakewalk/splat-data | Technicolor light-field video dataset (Sabater et al. 2017); Spacetime Gaussians; splaTV | research dataset, terms not confirmed; added at the user's request, check before commercial use | 4dv-player |
| Lightwheel pick-orange camera videos (`observation.images.front` / `.wrist`, 60 episodes) | https://huggingface.co/datasets/LightwheelAI/leisaac-pick-orange | Lightwheel | Apache-2.0 ; added at the user's request | physical-ai |
