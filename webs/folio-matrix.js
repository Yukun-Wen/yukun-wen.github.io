/* falling code for the Sci-fi series pages */
(function () {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) { return; }

    var canvas = document.createElement("canvas");
    canvas.className = "matrix";
    canvas.setAttribute("aria-hidden", "true");
    document.body.appendChild(canvas);

    var ctx = canvas.getContext("2d");
    var fs = 15;
    var W, H, cols, drops;
    var glyphs = "01アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワン";

    function resize() {
        W = canvas.width = window.innerWidth;
        H = canvas.height = window.innerHeight;
        cols = Math.ceil(W / fs);
        drops = [];
        for (var i = 0; i < cols; i++) { drops[i] = Math.random() * (H / fs); }
    }
    resize();
    window.addEventListener("resize", resize, { passive: true });

    var last = 0, acc = 0;

    function frame(now) {
        requestAnimationFrame(frame);
        if (!last) { last = now; }
        var dt = now - last;
        last = now;
        acc += dt;
        if (acc < 55) { return; }          /* about 18 frames a second */
        acc = 0;

        ctx.fillStyle = "rgba(2, 8, 14, 0.10)";
        ctx.fillRect(0, 0, W, H);
        ctx.font = fs + "px ui-monospace, monospace";

        for (var i = 0; i < cols; i++) {
            var ch = glyphs.charAt(Math.floor(Math.random() * glyphs.length));
            var y = drops[i] * fs;
            ctx.fillStyle = Math.random() < 0.05
                ? "rgba(210, 248, 255, 0.95)"
                : "rgba(70, 205, 240, 0.55)";
            ctx.fillText(ch, i * fs, y);

            if (y > H && Math.random() > 0.972) { drops[i] = 0; }
            drops[i] += 1;
        }
    }
    acc = 100;                       /* paint the first frame at once */
    frame(performance.now());
})();
