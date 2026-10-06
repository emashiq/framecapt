import logo32 from '../assets/logo-32.png';
import logo64 from '../assets/logo-64.png';
import logo128 from '../assets/logo-128.png';
import logo256 from '../assets/logo-256.png';

/** The sources closest to `size` CSS px: the 1x and 2x images, so the logo is crisp at 100 % and 200 %. */
function sources(size: number): { src: string; srcSet: string } {
  if (size <= 32) return { src: logo32, srcSet: `${logo32} 1x, ${logo64} 2x` };
  if (size <= 64) return { src: logo64, srcSet: `${logo64} 1x, ${logo128} 2x` };
  return { src: logo128, srcSet: `${logo128} 1x, ${logo256} 2x` };
}

/**
 * The FrameCapt logo (the owner's artwork). Decorative by default: the name is written next to it.
 * Pass `alt` where the image is the only thing that says what the app is.
 */
export function Logo({ size = 32, alt = '' }: { size?: number; alt?: string }) {
  const { src, srcSet } = sources(size);
  return (
    <img
      src={src}
      srcSet={srcSet}
      width={size}
      height={size}
      alt={alt}
      draggable={false}
      className="shrink-0 select-none"
    />
  );
}
