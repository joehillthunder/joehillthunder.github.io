# muse-avatar (gadget bridge)

The Muse Linux gadget plus a display hub for the 3D avatar page. It extends Meta's
[Linux Device SDK](https://github.com/facebookincubator/muse-gadget-sdk/tree/main/linux)
(`musegadget`) and installs into its venv.

```sh
sudo bash install-pi.sh        # after Meta's install.sh has paired the device
sudo muse-avatar url           # the page address with the bridge key
```

See [../README.md](../README.md) for setup, the commands Muse gets, the bridge protocol and the
development loop.
