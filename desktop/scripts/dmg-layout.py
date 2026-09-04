from pathlib import Path
import sys

from ds_store import DSStore
from mac_alias import ALIAS_EJECTABLE_DISK, Alias

root = Path(sys.argv[1]).resolve()
positions = {"Emma.app": (192, 192), "Applications": (448, 192)}
window = {
    "ShowToolbar": False,
    "ShowSidebar": False,
    "ShowStatusBar": False,
    "ShowPathbar": False,
    "ShowTabView": False,
    "WindowBounds": "{{200, 160}, {640, 424}}",
}
icons = {
    "viewOptionsVersion": 1,
    "backgroundType": 2,
    "backgroundColorRed": 28 / 255,
    "backgroundColorGreen": 27 / 255,
    "backgroundColorBlue": 30 / 255,
    "iconSize": 90.0,
    "textSize": 12.0,
    "gridOffsetX": 0.0,
    "gridOffsetY": 0.0,
    "gridSpacing": 100.0,
    "arrangeBy": "none",
    "showIconPreview": True,
    "showItemInfo": False,
    "labelOnBottom": True,
}

if sys.argv[2] == "--verify":
    with DSStore.open(str(root / ".DS_Store"), "r") as store:
        assert store["."]["bwsp"] == window
        saved = store["."]["icvp"]
        assert all(saved[key] == value for key, value in icons.items())
        for name, position in positions.items():
            assert store[name]["Iloc"] == position
        (root.parent / "background.alias").write_bytes(saved["backgroundImageAlias"])
else:
    alias = Alias.for_file(str(root / ".background.tiff"))
    alias.volume.disk_type = ALIAS_EJECTABLE_DISK
    icons["backgroundImageAlias"] = alias.to_bytes()
    with DSStore.open(str(root / ".DS_Store"), "w+") as store:
        store["."]["vSrn"] = ("long", 1)
        store["."]["bwsp"] = window
        store["."]["icvp"] = icons
        store["."]["icvl"] = ("type", b"icnv")
        for name, position in positions.items():
            store[name]["Iloc"] = position
