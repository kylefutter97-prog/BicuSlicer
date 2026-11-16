# Third-party notices

BicuSlicer vendors these libraries in `app/static/vendor/` (unmodified).

## three.js r160 (`three.module.min.js`, `addons/controls/OrbitControls.js`, `addons/loaders/*.js`)

https://github.com/mrdoob/three.js

```
The MIT License

Copyright © 2010-2023 three.js authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## fflate (`addons/libs/fflate.module.js`, as distributed with three.js r160)

https://github.com/101arrowz/fflate

```
MIT License

Copyright (c) 2023 Arjun Barrett

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Lucide icons v0.460.0 (`app/static/icons.svg`, built by `tools/icons/make_sprite.py`)

https://lucide.dev

```
ISC License

Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part of Feather (MIT). All other copyright (c) for Lucide are held by Lucide Contributors 2022.

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```

## occt-import-js 0.0.22 / Open CASCADE Technology (downloaded at run time, not in this repository or the image)

STEP and IGES files are converted to meshes in the browser by [occt-import-js](https://github.com/kovacsv/occt-import-js),
a WebAssembly build of [Open CASCADE Technology](https://dev.opencascade.org/). Both are licensed under the
**GNU Lesser General Public License 2.1** (Open CASCADE with its additional exception). BicuSlicer doesn't include or
modify them: the first time a STEP file is opened, the server downloads the unmodified `occt-import-js.js` and
`occt-import-js.wasm` (version 0.0.22, from `OCCT_URL`, default unpkg.com), checks them against pinned SHA-256
checksums (see `app/server.py`), stores them in `DATA_DIR/ext/` and serves them to the page. Their source code is at
https://github.com/kovacsv/occt-import-js and https://github.com/Open-Cascade-SAS/OCCT; you may replace them with
your own build of the same interface (point `OCCT_URL` at it and update the checksums).

## OrcaSlicer (in the Docker image, not in this repository)

The Docker image built from this repository's `Dockerfile` contains an unmodified copy of OrcaSlicer, unpacked from its official Linux AppImage for the version set by the `ORCA_VERSION` build argument (default 2.5.1).

- Licence: GNU Affero General Public License v3.0. The full text ships inside the image with OrcaSlicer and is at https://github.com/OrcaSlicer/OrcaSlicer/blob/main/LICENSE.
- Source for the exact version: https://github.com/OrcaSlicer/OrcaSlicer/tree/v2.5.1, or the tag matching `ORCA_VERSION`.
- BicuSlicer runs OrcaSlicer as a separate program, its command line, and does not link to or modify it.

On first start, BicuSlicer also downloads OrcaSlicer's settings definitions and vendor profiles from that repository, for the same version, into its data folder (`DATA_DIR/orca/<tag>/`). These are OrcaSlicer's work under the same licence and are not part of this repository.

The image also contains Ubuntu 24.04 packages (GTK, WebKitGTK, Python, aiohttp and their dependencies) under their own licences. They are listed in each package's `/usr/share/doc/<package>/copyright`.
