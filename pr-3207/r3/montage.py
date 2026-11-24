import sys
from PIL import Image, ImageDraw
# usage: montage.py out.png "x0,y0,x1,y1" scale label=path ...
out, box, scale = sys.argv[1], [int(v) for v in sys.argv[2].split(',')], float(sys.argv[3])
panels = []
for item in sys.argv[4:]:
    label, path = item.split('=', 1)
    image = Image.open(path).convert('RGB').crop(box)
    image = image.resize((int(image.width * scale), int(image.height * scale)), Image.LANCZOS)
    panel = Image.new('RGB', (image.width, image.height + 22), (20, 20, 20))
    panel.paste(image, (0, 22))
    ImageDraw.Draw(panel).text((6, 5), label, fill=(255, 255, 255))
    panels.append(panel)
sheet = Image.new('RGB', (sum(p.width for p in panels) + 4 * (len(panels) - 1), max(p.height for p in panels)), (255, 255, 255))
x = 0
for panel in panels:
    sheet.paste(panel, (x, 0)); x += panel.width + 4
sheet.save(out)
print(out, sheet.size)
