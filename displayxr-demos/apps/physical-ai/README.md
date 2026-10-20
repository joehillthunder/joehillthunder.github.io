# Physical AI Lab

Train a robot policy end to end in the browser, on [Lightwheel](https://lightwheel.ai/)'s simulation assets
and data. Glasses-free 3D in the DisplayXR Browser on a Leia display, 2D in any other browser.

**Live:** https://joehillthunder.github.io/displayxr-demos/apps/physical-ai/

1. **World.** Lightwheel's SimReady `kitchen_with_orange` scene and SO-101 follower arm (the assets their
   open-source [LeIsaac](https://github.com/LightwheelAI/leisaac) uses in Isaac Lab), converted from USD.
   Tap an asset for its card. Domain randomisation uses LeIsaac's own ranges, and you can switch the lighting.
2. **Demonstrations.** All 60 teleop episodes of
   [LightwheelAI/leisaac-pick-orange](https://huggingface.co/datasets/LightwheelAI/leisaac-pick-orange) replayed
   on the arm, with Lightwheel's front and wrist camera renders streamed from Hugging Face and the joint traces. You
   can also generate synthetic demos with a port of Lightwheel's datagen state machine, or record your own by teleop.
3. **Train.** Behaviour cloning in a web worker, then DAgger with the state machine as the expert.
4. **Evaluate.** A RoboFinals-style benchmark: 9 to 36 randomised episodes in a 3×3 grid of parallel envs,
   scored with LeIsaac's `task_done()` and subtask terms, plus a leaderboard.

A typical run: generate 40 synthetic demos, train BC (about 0/10 on new layouts; it drifts), add 4 DAgger
rounds (about 10/10), then evaluate (100% on 9 episodes, about 14 s each).

Keys: `1`–`4` chapters, `Space` play/pause, `?` about. In teleop: `W A S D` move, `R`/`F` up/down, `Space`
gripper, `Q`/`E` roll, `Enter` save. Flags: `?2d` forces 2D, `?step=demos` opens a chapter, `?intro` shows the intro.

Not affiliated with or endorsed by Lightwheel. Assets and data are theirs, under Apache-2.0 (see
`../../assets/LICENSES.md`).
