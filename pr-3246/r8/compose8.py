import sys
from PIL import Image, ImageDraw
folder = sys.argv[1]
def band(name, box):
    return Image.open(f"{folder}/{name}").convert("RGB").crop(box)
rows = []
for colour in ("red", "blue", "default"):
    rows.append(band(f"row-{colour}.png", (0, 430, 1080, 650)))
    rows.append(band(f"row-{colour}-pt.png", (0, 430, 1080, 650)))
glass = Image.new("RGB", (1080, 2 * 380), "white")
glass.paste(band("glass-grey.png", (0, 340, 1080, 720)), (0, 0))
glass.paste(band("glass-checker.png", (0, 340, 1080, 720)), (0, 380))
grass = band("grass-face.png", (230, 230, 850, 850))
sheet = Image.new("RGB", (1080, 6 * 226 + 760 + 4), "white")
y = 0
for image in rows:
    sheet.paste(image, (0, y)); y += 226
sheet.paste(glass, (0, y))
sheet.save(f"{folder}/sheet-rows-glass.png")
grass.save(f"{folder}/grass-face-crop.png")
