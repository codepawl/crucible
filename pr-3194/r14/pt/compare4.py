import numpy as np
import compare_helpers as c
from compare_helpers import luminance, glaze_image, pt_image, masks, VIEWS
puddle, road, ground = masks('hero-clouds', VIEWS['hero-clouds'][1])
gw = luminance(glaze_image('hero-clouds-flat-wet'))[puddle].mean(); gb = luminance(glaze_image('hero-clouds-black'))[puddle].mean()
pf = luminance(pt_image('hero-clouds-puddle-flat'))[puddle].mean(); pb = luminance(pt_image('hero-clouds-puddle-black'))[puddle].mean()
print('glaze flat-wet', round(gw, 4), 'black', round(gb, 4), 'bed delta per albedo', round((gw - gb) / 0.3, 3))
print('pt flat', round(pf, 4), 'black', round(pb, 4), 'bed delta per albedo', round((pf - pb) / 0.3, 3))
print('effective Glaze bed multiplier on albedo', round(((gw - gb) / 0.3) / ((pf - pb) / 0.3), 3))
