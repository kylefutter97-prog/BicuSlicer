"""A small OrcaSlicer-style project for tools/ui_import_test.py: plate 1 "Cubes A" holds a cube with its own infill (30%),
a modifier part with denser infill (80%), painted supports (one split triangle "48043", one blocker) and a painted
seam, and a copy turned 90°; plate 2 "Cube B" (print sequence by object) holds a small cube with 4 walls.

    python3 tools/make_test_project.py input.3mf 220        # 220 = bed width of the printer you'll test with

Then let OrcaSlicer itself write it out as a real project (sub-object files, plates, project settings):

    orca-slicer --datadir <dir> --load-settings "machine.json;process.json" --load-filaments filament.json \
        --arrange 0 --orient 0 --export-3mf project.3mf input.3mf

Plate 2 sits where OrcaSlicer lays out a second plate: x + bed width x 1.2."""
import sys, zipfile
W = float(sys.argv[2]) if len(sys.argv) > 2 else 220.0      # bed width

def cube(x0, y0, z0, s):
    v = [(x0 + x, y0 + y, z0 + z) for x in (0, s) for y in (0, s) for z in (0, s)]
    f = [(0, 2, 1), (1, 2, 3), (4, 5, 6), (5, 7, 6), (0, 1, 4), (1, 5, 4), (2, 6, 3), (3, 6, 7), (0, 4, 2), (2, 4, 6), (1, 3, 5), (3, 7, 5)]
    return v, f

def mesh(v, f, paint=None):
    vs = "".join(f'<vertex x="{a}" y="{b}" z="{c}"/>' for a, b, c in v)
    ts = []
    for i, (a, b, c) in enumerate(f):
        extra = (paint or {}).get(i, "")
        ts.append(f'<triangle v1="{a}" v2="{b}" v3="{c}"{extra}/>')
    return f"<mesh><vertices>{vs}</vertices><triangles>{''.join(ts)}</triangles></mesh>"

va, fa = cube(-10, -10, 0, 20)
vm, fm = cube(-5, -5, 5, 10)
vb, fb = cube(-6, -6, 0, 12)
paint = {0: ' paint_supports="48043"', 1: ' paint_supports="8"', 4: ' paint_seam="4"'}
model = f'''<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources>
<object id="1" type="model" name="body">{mesh(va, fa, paint)}</object>
<object id="2" type="model" name="mod">{mesh(vm, fm)}</object>
<object id="3" type="model" name="A"><components><component objectid="1"/><component objectid="2"/></components></object>
<object id="4" type="model" name="B">{mesh(vb, fb)}</object>
</resources><build>
<item objectid="3" transform="1 0 0 0 1 0 0 0 1 60 80 0"/>
<item objectid="3" transform="0 1 0 -1 0 0 0 0 1 120 80 0"/>
<item objectid="4" transform="1 0 0 0 1 0 0 0 1 {W * 1.2 + 100} 100 0"/>
</build></model>'''
cfg = '''<?xml version="1.0" encoding="UTF-8"?>
<config>
  <object id="3">
    <metadata key="name" value="Cube with modifier"/>
    <metadata key="sparse_infill_density" value="30%"/>
    <part id="1" subtype="normal_part"><metadata key="name" value="body"/></part>
    <part id="2" subtype="modifier_part"><metadata key="name" value="denser core"/><metadata key="sparse_infill_density" value="80%"/></part>
  </object>
  <object id="4">
    <metadata key="name" value="Small cube"/>
    <metadata key="wall_loops" value="4"/>
  </object>
  <plate>
    <metadata key="plater_id" value="1"/>
    <metadata key="plater_name" value="Cubes A"/>
    <model_instance><metadata key="object_id" value="3"/><metadata key="instance_id" value="0"/></model_instance>
    <model_instance><metadata key="object_id" value="3"/><metadata key="instance_id" value="1"/></model_instance>
  </plate>
  <plate>
    <metadata key="plater_id" value="2"/>
    <metadata key="plater_name" value="Cube B"/>
    <metadata key="print_sequence" value="by object"/>
    <model_instance><metadata key="object_id" value="4"/><metadata key="instance_id" value="0"/></model_instance>
  </plate>
</config>'''
with zipfile.ZipFile(sys.argv[1], "w", zipfile.ZIP_DEFLATED) as z:
    z.writestr("[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>')
    z.writestr("_rels/.rels", '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>')
    z.writestr("3D/3dmodel.model", model)
    z.writestr("Metadata/model_settings.config", cfg)
print("ok")
