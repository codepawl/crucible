import sys, glob
from PIL import Image
# usage: tile.py <frame folder> <out png> [first frame index]: 12 consecutive hull crops in a 4x3 grid, at native size
files = sorted(glob.glob(sys.argv[1] + "/*.png"))
first = int(sys.argv[3]) if len(sys.argv) > 3 else 0
frames = [Image.open(file).convert("RGB") for file in files[first:first + 12]]
w, h = frames[0].size
box = (int(0.19 * w), int(0.63 * h), int(0.75 * w), int(0.84 * h))
crops = [frame.crop(box).resize(((box[2] - box[0]) * 1, (box[3] - box[1]) * 1), Image.LANCZOS) for frame in frames]
cw, ch = crops[0].size
sheet = Image.new("RGB", (cw * 4, ch * 3))
for i, crop in enumerate(crops):
    sheet.paste(crop, ((i % 4) * cw, (i // 4) * ch))
sheet.save(sys.argv[2])
