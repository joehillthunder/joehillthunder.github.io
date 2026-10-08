# Changes needed in packages/

Apps never edit `packages/`. If an app needs a change there, add a note below. A package owner
makes the change on its own branch.

Template:

```
## <short title>
- From: apps/<name> (branch app/<name>)
- Package: packages/<core|importer>
- Need: what the app needs, and why
- Proposed API: the call the app wants to make
- Status: open | in progress | done (<commit>)
```

<!-- notes go below this line -->
