# Updating OrcaSlicer in BicuSlicer

BicuSlicer bundles a specific OrcaSlicer version (the `ORCA_VERSION` build argument in the `Dockerfile`). Everything that depends on it follows automatically:
- the settings list;
- the vendor profiles;
- the per-part settings list and the named setting rows;
- OrcaSlicer's defaults.

These are downloaded for that version the first time a new version starts.

New OrcaSlicer releases are never picked up silently. A workflow tests each one and proposes it as a pull request, and a person decides.

## The flow

1. **Detect.** Every Monday the [OrcaSlicer update](../.github/workflows/orca-update.yml) workflow compares the latest stable OrcaSlicer release with `ORCA_VERSION`.
2. **Test.** When there's a newer release, the workflow:
   - builds BicuSlicer with it and starts it with an empty data volume;
   - runs [`tools/smoke_test.py`](../tools/smoke_test.py) against it;
   - runs [`tools/settings_diff.py`](../tools/settings_diff.py) for the old and new versions.

   The smoke test checks that the new version's settings, per-part list and named rows were generated, then slices for real and checks each result in the G-code or the weights:
   - a custom Klipper printer;
   - unsaved edits;
   - the plate type;
   - a modifier part and a negative part;
   - painted support blocking;
   - thumbnails, the layer preview and auto-orient;
   - a vendor printer.
3. **Propose.** It opens a pull request `OrcaSlicer X.Y.Z` that bumps the version in the Dockerfile, the image workflow and the docs. The smoke-test results and the settings diff are in the description. If the smoke test failed, the pull request is a **draft**.
4. **Review.** Read the OrcaSlicer release notes (linked) and the settings diff. **Removed or renamed settings** matter most: a saved preset that sets one loses that value in the new version. Merge when happy.
5. **Release.** Tag the merge, for example:
   ```sh
   git tag -a v0.2.0 -m "OrcaSlicer 2.6.0"
   git push origin v0.2.0
   ```
   The **Docker image** workflow then publishes `:0.2.0`, `:latest` and `:orca-2.6.0` for amd64 and arm64.
6. **Update an install.** Run:
   ```sh
   docker compose pull
   docker compose up -d
   ```
   The first start downloads the new version's settings and profiles (a few minutes). The previous version's data is kept, so going back is instant: pin the image to the old `:orca-X.Y.Z` tag. Older versions' data is deleted automatically.

If you also run the OrcaSlicer desktop app with shared presets, update it to the same version, so presets saved by one load in the other.

## Running the pieces by hand

- **Dry run** of the whole workflow for any version, without opening a pull request: Actions → *OrcaSlicer update* → *Run workflow*, enter a version and untick *Open a pull request*.
- **Smoke test** against any running BicuSlicer. Use a throwaway instance, because it adds a "Smoke Klipper" printer:
  ```sh
  python3 tools/smoke_test.py --url http://localhost:8000 --report smoke.md
  ```
- **Settings diff** between any two OrcaSlicer tags (takes a few seconds):
  ```sh
  python3 tools/settings_diff.py --old v2.5.0 --new v2.5.1
  ```

## One-time GitHub setting

For the workflow to open pull requests, enable **Settings → Actions → General → Workflow permissions → "Allow GitHub Actions to create and approve pull requests"**.

## If something breaks

- **The smoke test fails at "settings catalogue parsed" or "per-part settings list".** OrcaSlicer changed the shape of its source code. Fix `app/tools/orca_data.py` or `app/tools/orca_scopes.py`. They check their own output and fail loudly rather than produce a wrong settings list.
- **A slice check fails.** Look at the workflow's `bicuslicer.log` artifact, and try the same slice in the OrcaSlicer desktop app at that version. Sometimes OrcaSlicer changes a setting's meaning, and the settings diff usually shows which one.
