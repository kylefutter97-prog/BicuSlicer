"""Preset engine: OrcaSlicer-format presets from three sources, resolved without the GUI.

Sources (highest precedence first when names collide):
  user    BicuSlicer's own store (DATA_DIR/presets/<type>/<name>.json), editable
  orca    an OrcaSlicer data folder's user presets (ORCA_DIR/user/<id>/<type>/), read-only
  system  OrcaSlicer's vendor library (fetched by tools/orca_data.py into DATA_DIR/orca/<tag>/profiles), read-only

Types use Orca's names: "machine" (printer), "process" (print settings), "filament".
A preset is a dict of setting -> value plus "name", "type", optional "inherits".
resolve() walks the inherits chain and merges, child over parent, like OrcaSlicer does.
"""

from __future__ import annotations

import json
import re
import zipfile
from io import BytesIO
from pathlib import Path

TYPES = ("machine", "process", "filament")
META_KEYS = {"name", "type", "inherits", "from", "instantiation", "setting_id", "filament_id", "base_id",
             "user_id", "updated_time", "version", "is_custom_defined", "renamed_from", "description"}
SAFE_NAME = re.compile(r"^[^/\\\x00-\x1f]{1,120}$")


class PresetError(Exception):
    pass


def _read(path: Path) -> dict | None:
    try:
        j = json.loads(path.read_text(encoding="utf-8"))
        return j if isinstance(j, dict) else None
    except (OSError, ValueError):
        return None


class Library:
    def __init__(self, user_dir: Path, orca_dir: Path | None, system_dir: Path | None):
        self.user_dir = user_dir
        self.orca_dir = orca_dir
        self.system_dir = system_dir
        self.reload()

    # ------------------------------------------------------------------ loading

    def reload(self) -> None:
        self._cache: dict[tuple[str, str], dict] = {}
        # system[vendor][type][name] = (path, data)  — data loaded lazily for big vendors
        self.system: dict[str, dict[str, dict[str, Path]]] = {}
        self.system_meta: dict[tuple[str, str], dict] = {}   # (type, name) -> {"vendor", "instantiation", "inherits", "model"}
        self.vendors: dict[str, dict] = {}
        if self.system_dir and self.system_dir.is_dir():
            for index in sorted(self.system_dir.glob("*.json")):
                vendor = index.stem
                idx = _read(index) or {}
                self.vendors[vendor] = {"name": idx.get("name", vendor), "version": idx.get("version"),
                                        "models": [m.get("name") for m in idx.get("machine_model_list", [])]}
                vt = self.system.setdefault(vendor, {t: {} for t in TYPES + ("machine_model",)})
                vdir = self.system_dir / vendor
                if not vdir.is_dir():
                    continue
                for f in vdir.rglob("*.json"):
                    d = _read(f)
                    if not d or "name" not in d:
                        continue
                    t = d.get("type")
                    if t not in vt:
                        continue
                    vt[t][d["name"]] = f
                    if t in TYPES:
                        key = (t, d["name"])
                        # first vendor wins for metadata, but keep instantiable presets over templates
                        if key not in self.system_meta or (d.get("instantiation") == "true"
                                                          and self.system_meta[key]["instantiation"] != "true"):
                            self.system_meta[key] = {"vendor": vendor, "instantiation": d.get("instantiation", "true"),
                                                     "inherits": d.get("inherits", ""),
                                                     "model": d.get("printer_model"), "variant": d.get("printer_variant"),
                                                     "compatible_printers": d.get("compatible_printers")}
        self.orca: dict[str, dict[str, Path]] = {t: {} for t in TYPES}
        if self.orca_dir and (self.orca_dir / "user").is_dir():
            base = self.orca_dir / "user"
            sub = base / "default" if (base / "default").is_dir() else next((p for p in sorted(base.iterdir()) if p.is_dir()), None)
            if sub:
                for t in TYPES:
                    for f in sorted((sub / t).glob("*.json")) if (sub / t).is_dir() else []:
                        d = _read(f)
                        if d and d.get("name"):
                            self.orca[t][d["name"]] = f
        self.user: dict[str, dict[str, Path]] = {t: {} for t in TYPES}
        for t in TYPES:
            (self.user_dir / t).mkdir(parents=True, exist_ok=True)
            for f in sorted((self.user_dir / t).glob("*.json")):
                d = _read(f)
                if d and d.get("name"):
                    self.user[t][d["name"]] = f

    # ------------------------------------------------------------------ lookup

    def find(self, t: str, name: str, vendor_hint: str | None = None) -> tuple[str, dict]:
        """Return (source, raw preset). Source is 'user', 'orca' or 'system:<Vendor>'."""
        if name in self.user[t]:
            return "user", _read(self.user[t][name]) or {}
        if name in self.orca[t]:
            return "orca", _read(self.orca[t][name]) or {}
        vendors = []
        if vendor_hint and vendor_hint in self.system:
            vendors.append(vendor_hint)
        if t == "filament" and "OrcaFilamentLibrary" in self.system:
            vendors.append("OrcaFilamentLibrary")
        meta = self.system_meta.get((t, name))
        if meta:
            vendors.append(meta["vendor"])
        vendors += [v for v in self.system if v not in vendors]
        for v in vendors:
            p = self.system[v][t].get(name)
            if p:
                return f"system:{v}", _read(p) or {}
        raise PresetError(f"No {t} preset named '{name}'")

    def chain(self, t: str, name: str) -> list[tuple[str, dict]]:
        """[(source, raw)] from the preset up to its root ancestor."""
        out, seen, vendor = [], set(), None
        while name:
            if name in seen:
                raise PresetError(f"Inheritance loop at '{name}'")
            seen.add(name)
            src, raw = self.find(t, name, vendor)
            if src.startswith("system:"):
                vendor = src.split(":", 1)[1]
            out.append((src, raw))
            name = raw.get("inherits") or ""
        return out

    def resolve(self, t: str, name: str) -> dict:
        """All settings this preset sets directly or inherits (not including OrcaSlicer's built-in defaults)."""
        key = (t, name)
        if key not in self._cache:
            values: dict = {}
            for _, raw in reversed(self.chain(t, name)):
                for k, v in raw.items():
                    if k not in META_KEYS:
                        values[k] = v
            self._cache[key] = values
        return dict(self._cache[key])

    def parent_values(self, t: str, name: str) -> dict:
        ch = self.chain(t, name)
        return self.resolve(t, ch[0][1]["inherits"]) if ch[0][1].get("inherits") else {}

    # ------------------------------------------------------------------ listing

    def listing(self, t: str, include_system: bool = True, vendors: set[str] | None = None) -> list[dict]:
        rows, seen = [], set()
        for src, table in (("user", self.user[t]), ("orca", self.orca[t])):
            for name, path in table.items():
                if name in seen:
                    continue
                seen.add(name)
                raw = _read(path) or {}
                rows.append({"name": name, "source": src, "inherits": raw.get("inherits") or "", "editable": src == "user"})
        if include_system:
            for (tt, name), meta in self.system_meta.items():
                if tt != t or name in seen or meta["instantiation"] != "true":
                    continue
                if vendors is not None and meta["vendor"] not in vendors:
                    continue
                seen.add(name)
                rows.append({"name": name, "source": "system", "vendor": meta["vendor"], "inherits": meta["inherits"],
                             "editable": False})
        return rows

    def ancestors(self, t: str, name: str) -> list[str]:
        try:
            return [raw.get("name", "") for _, raw in self.chain(t, name)]
        except PresetError:
            return [name]

    def explicit_compat(self, t: str, name: str) -> list[str] | None:
        """compatible_printers after inheritance ([] = any printer); None if the preset can't be resolved."""
        key = ("compat", t, name)
        if key not in self._cache:
            try:
                self._cache[key] = list(self.resolve(t, name).get("compatible_printers") or [])
            except PresetError:
                self._cache[key] = None
        return self._cache[key]

    def compatible(self, t: str, name: str, machine: str) -> bool:
        """OrcaSlicer's compatible_printers list check (conditions are not evaluated)."""
        allowed = self.explicit_compat(t, name)
        if allowed is None:
            return False
        if not allowed:
            return True
        akey = ("anc", machine)
        if akey not in self._cache:
            self._cache[akey] = set(self.ancestors("machine", machine))
        return bool(set(allowed) & self._cache[akey])

    # ------------------------------------------------------------------ user store

    def user_path(self, t: str, name: str) -> Path:
        if t not in TYPES or not SAFE_NAME.match(name or "") or name.strip() != name or name in (".", ".."):
            raise PresetError("Use a name without slashes or control characters")
        return self.user_dir / t / f"{name}.json"

    def save_user(self, t: str, name: str, inherits: str, values: dict, replace: str | None = None) -> dict:
        """Save a user preset as Orca does: only the settings that differ from the parent, plus inherits."""
        if inherits:
            self.find(t, inherits)   # must exist
            parent = self.resolve(t, inherits)
        else:
            parent = {}
        diff = {k: v for k, v in values.items() if k not in META_KEYS and parent.get(k) != v}
        preset = {"type": t, "name": name, "inherits": inherits, "from": "User", "instantiation": "true", **diff}
        path = self.user_path(t, name)
        if replace and replace != name:
            if name in self.user[t] or name in self.orca[t] or (t, name) in self.system_meta:
                raise PresetError(f"A {t} preset named '{name}' already exists")
            old = self.user_path(t, replace)
            if old.exists():
                old.unlink()
        tmp = path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(preset, indent=4), encoding="utf-8")
        tmp.replace(path)
        self.reload()
        return preset

    def delete_user(self, t: str, name: str) -> None:
        path = self.user_path(t, name)
        if not path.exists():
            raise PresetError("Only your own BicuSlicer presets can be deleted")
        path.unlink()
        self.reload()

    # ------------------------------------------------------------------ slicing / export

    def flattened(self, t: str, name: str, overrides: dict | None = None, out_name: str | None = None) -> dict:
        """A standalone copy with every inherited setting written out (what the CLI gets, and what export gives)."""
        values = self.resolve(t, name)
        if overrides:
            values.update({k: v for k, v in overrides.items() if k not in META_KEYS})
        preset = {"type": t, "name": out_name or name, "inherits": "", "from": "User", "instantiation": "true", **values}
        return preset

    def export_bundle(self, items: list[tuple[str, str]]) -> bytes:
        """A zip of flattened presets that BicuSlicer (and OrcaSlicer, one file at a time) can import."""
        buf = BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
            for t, name in items:
                z.writestr(f"{t}/{name}.json", json.dumps(self.flattened(t, name), indent=4))
        return buf.getvalue()

    def import_file(self, filename: str, data: bytes) -> list[dict]:
        """Import .json presets, or zips/Orca bundles (.zip, .orca_printer, .orca_filament, .orca_bundle) of them."""
        found: list[dict] = []
        lower = filename.lower()
        if lower.endswith(".json"):
            found.append(_parse_preset(data, filename, self))
        elif zipfile.is_zipfile(BytesIO(data)):
            with zipfile.ZipFile(BytesIO(data)) as z:
                for info in z.infolist():
                    if info.is_dir() or not info.filename.lower().endswith(".json") or info.file_size > 5_000_000:
                        continue
                    if Path(info.filename).name == "bundle_structure.json":
                        continue
                    try:
                        found.append(_parse_preset(z.read(info), info.filename, self))
                    except PresetError:
                        continue
        else:
            raise PresetError("Import a .json preset, or a .zip / .orca_printer / .orca_filament / .orca_bundle file")
        if not found:
            raise PresetError("No presets found in that file")
        imported = []
        for p in found:
            t, name = p["type"], p["name"]
            inherits = p.get("inherits") or ""
            values = {k: v for k, v in p.items() if k not in META_KEYS}
            if inherits:
                try:
                    self.find(t, inherits)
                except PresetError:
                    inherits = ""   # parent unknown here: keep it as a standalone preset
            if not inherits and len(values) < 30:
                imported.append({"type": t, "name": name, "skipped": "it only lists changes from a parent preset this library doesn't have"})
                continue
            final = name
            n = 2
            while final in self.user[t] or final in self.orca[t] or (t, final) in self.system_meta:
                final = f"{name} ({n})"
                n += 1
            # keep it exactly as given: inherited values stay inherited
            preset = {"type": t, "name": final, "inherits": inherits, "from": "User", "instantiation": "true", **values}
            path = self.user_path(t, final)
            path.write_text(json.dumps(preset, indent=4), encoding="utf-8")
            self.reload()
            imported.append({"type": t, "name": final})
        return imported


def _parse_preset(data: bytes, filename: str, lib: "Library | None" = None) -> dict:
    try:
        p = json.loads(data.decode("utf-8-sig"))
    except (UnicodeDecodeError, ValueError):
        raise PresetError(f"{filename} isn't valid JSON")
    if not isinstance(p, dict):
        raise PresetError(f"{filename} isn't a preset")
    t = p.get("type")
    if t == "printer":
        t = "machine"
    if t == "print":
        t = "process"
    if t not in TYPES:
        # OrcaSlicer's user preset files carry no type: use the parent's type, or the folder name, or a telltale key
        t = None
        parent = p.get("inherits")
        if lib and parent:
            t = next((tt for tt in TYPES if (tt, parent) in lib.system_meta or parent in lib.orca[tt] or parent in lib.user[tt]), None)
        if not t:
            parts = {x.lower() for x in Path(filename).parts}
            t = next((tt for tt in TYPES if tt in parts), None) or ("machine" if "printer" in parts else None)
        if not t:
            keys = set(p)
            t = ("machine" if keys & {"printable_area", "machine_start_gcode", "nozzle_diameter", "printer_model"} else
                 "filament" if any(k.startswith("filament_") or k in ("nozzle_temperature", "hot_plate_temp") for k in keys) else
                 "process" if keys & {"layer_height", "wall_loops", "sparse_infill_density"} else None)
    if not t:
        raise PresetError(f"{filename}: can't tell whether this is a printer, filament or process preset")
    name = p.get("name") or Path(filename).stem
    p["type"], p["name"] = t, str(name).strip()[:120]
    return p
