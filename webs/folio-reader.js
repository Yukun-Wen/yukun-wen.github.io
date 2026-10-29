/* Turn a .gallery.book-source into a single-page, turning book. */
(function () {
    var src = document.querySelector(".book-source");
    if (!src) { return; }

    var shots = Array.prototype.slice.call(src.querySelectorAll(".shot"));
    if (shots.length < 2) { return; }

    var pages = shots.map(function (s) {
        return {
            src: s.getAttribute("data-full") || s.querySelector("img").src,
            alt: s.getAttribute("data-alt") || ""
        };
    });

    /* build the reader */
    var book = document.createElement("section");
    book.className = "book";
    book.innerHTML =
        '<div class="book-stage">' +
        '  <button class="book-nav prev" type="button" aria-label="Previous page">\u2039</button>' +
        '  <figure class="book-page"><img id="bookImg" alt=""></figure>' +
        '  <button class="book-nav next" type="button" aria-label="Next page">\u203a</button>' +
        '</div>' +
        '<div class="book-foot">' +
        '  <span id="bookNo">01 / ' + String(pages.length).padStart(2, "0") + '</span>' +
        '  <div class="book-rail"><i id="bookBar"></i></div>' +
        '  <span class="book-hint">turn the page \u2190 \u2192</span>' +
        '</div>';

    src.parentNode.insertBefore(book, src);
    src.style.display = "none";
    document.body.classList.add("has-book");

    var page = book.querySelector(".book-page");
    var img = book.querySelector("#bookImg");
    var no = book.querySelector("#bookNo");
    var bar = book.querySelector("#bookBar");
    var at = 0;
    var turning = false;

    function paint() {
        img.src = pages[at].src;
        img.alt = pages[at].alt;
        no.textContent = String(at + 1).padStart(2, "0") + " / " +
                         String(pages.length).padStart(2, "0");
        bar.style.width = ((at + 1) / pages.length * 100) + "%";
    }

    function turn(dir) {
        if (turning) { return; }
        var reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        if (reduce) {
            at = (at + dir + pages.length) % pages.length;
            paint();
            return;
        }
        turning = true;
        page.classList.add("is-turning", dir > 0 ? "turn-next" : "turn-prev");

        setTimeout(function () {
            at = (at + dir + pages.length) % pages.length;
            paint();

            page.classList.remove("turn-next", "turn-prev");
            /* start the incoming leaf from the other side, then release it */
            page.style.transition = "none";
            page.style.transform = "rotateY(" + (dir > 0 ? 42 : -42) + "deg)";
            page.style.opacity = "0";
            void page.offsetWidth;
            page.style.transition = "";
            page.style.transform = "";
            page.style.opacity = "";

            setTimeout(function () {
                page.classList.remove("is-turning");
                turning = false;
            }, 420);
        }, 440);
    }

    book.querySelector(".next").addEventListener("click", function (e) { e.stopPropagation(); turn(1); });
    book.querySelector(".prev").addEventListener("click", function (e) { e.stopPropagation(); turn(-1); });

    /* click left half to go back, right half to go on */
    page.addEventListener("click", function (e) {
        var r = page.getBoundingClientRect();
        turn((e.clientX - r.left) > r.width / 2 ? 1 : -1);
    });

    document.addEventListener("keydown", function (e) {
        if (e.key === "ArrowRight") { turn(1); }
        if (e.key === "ArrowLeft") { turn(-1); }
    });

    /* swipe */
    var x0 = null;
    book.addEventListener("touchstart", function (e) { x0 = e.touches[0].clientX; }, { passive: true });
    book.addEventListener("touchend", function (e) {
        if (x0 === null) { return; }
        var dx = e.changedTouches[0].clientX - x0;
        if (Math.abs(dx) > 46) { turn(dx < 0 ? 1 : -1); }
        x0 = null;
    }, { passive: true });

    paint();
})();
