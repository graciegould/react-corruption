# How it works

The effect repeatedly displaces blocks from the previous rendered frame. Because
each frame becomes the input to the next, distortion accumulates. Pointer movement
supplies motion; healing blends the original image back into the result.

The engine operates on pixels in a Canvas 2D buffer. It can also
estimate movement between video frames and use that motion to displace a held frame.

For DOM content, the library clones the content, copies its computed styles, and
renders the clone through an SVG `foreignObject`. The resulting image supplies the
engine's pixels. The real DOM remains in place underneath a decorative canvas.

At rest, the original content is shown at its native quality. During distortion,
its opacity changes while the canvas is shown. The original retains its layout,
semantics, and event handlers. Keyboard-focused controls stay visible.

Capture is a best-effort snapshot. Fonts and external resources have to be
available inside the SVG, and not every browser feature survives serialization.
When capture fails, the wrapper leaves the original visible and calls `onError`.
