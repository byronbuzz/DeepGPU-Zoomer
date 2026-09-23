/** Screen x is right, while complex y is up. Cardinal values stay exact. */
export function rotationBasis(angle = 0): { c: number; s: number } {
  angle %= 360;if(angle>180)angle-=360;if(angle< -180)angle+=360;
  switch (angle) {
    case 0: return { c: 1, s: 0 };
    case 90: return { c: 0, s: 1 };
    case -90: return { c: 0, s: -1 };
    case 180: case -180: return { c: -1, s: 0 };
    default: {
      const radians = angle * Math.PI / 180;
      return { c: Math.cos(radians), s: Math.sin(radians) };
    }
  }
}
