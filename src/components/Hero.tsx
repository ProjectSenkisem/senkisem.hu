import { useEffect, useState, useRef, useCallback } from "react";

const Hero = () => {
  const [showScrollHint, setShowScrollHint] = useState(false);
  const [videoReady, setVideoReady] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const hintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Videó betöltési handler
  const handleCanPlayThrough = useCallback(() => {
    if (!videoRef.current) return;

    // Videót elindítjuk
    videoRef.current.play().catch(() => {});

    // Jelezzük az index.html-nek, hogy a videó ready
    if (typeof (window as any).notifyVideoReady === "function") {
      (window as any).notifyVideoReady();
    }

    setVideoReady(true);
  }, []);

  // Amikor a preloader eltűnt és a videó is ready, indul a scroll hint timer
  useEffect(() => {
    if (!videoReady) return;

    // Várunk a loadingDone-ra (preloader fadeout-ja befejeződött)
    const waitForLoader = () => {
      if ((window as any).loadingDone) {
        // Videó kezdetétől számolunk 5s-et
        hintTimerRef.current = setTimeout(() => {
          setShowScrollHint(true);
        }, 5000);
      } else {
        requestAnimationFrame(waitForLoader);
      }
    };
    waitForLoader();

    return () => {
      if (hintTimerRef.current) clearTimeout(hintTimerRef.current);
    };
  }, [videoReady]);

  // Scroll hint fade-in CSS-szel, nem GSAP
  useEffect(() => {
    if (!showScrollHint) return;
    const el = document.getElementById("scroll-hint");
    if (el) {
      // Egy frame delay, hogy a browser a rendered állapotot rögzítse
      requestAnimationFrame(() => {
        el.style.opacity = "1";
        el.style.transform = "translateX(-50%) translateY(0)";
      });
    }
  }, [showScrollHint]);

  return (
    <div className="relative h-dvh w-screen overflow-x-hidden">
      <div
        id="video-frame"
        className="relative z-10 h-dvh w-screen overflow-hidden bg-black"
      >
        {/* HERO VIDEO */}
        <video
          ref={videoRef}
          src="videos/hero-1.mp4"
          loop
          muted
          playsInline
          preload="auto"
          onCanPlayThrough={handleCanPlayThrough}
          className="
            absolute inset-0
            w-full h-full
            object-cover
          "
          style={{
            objectPosition: "center center",
          }}
        />

        {/* SCROLL HINT — CSS transition, nem GSAP */}
        {showScrollHint && (
          <div className="pointer-events-none absolute bottom-8 left-1/2 z-50">
            <p
              id="scroll-hint"
              className="text-sm font-light tracking-wide text-neutral-300"
              style={{
                opacity: 0,
                transform: "translateX(-50%) translateY(20px)",
                transition: "opacity 1.5s ease, transform 1.5s ease",
              }}
            >
              Lapozz a további tartalomért
            </p>
          </div>
        )}
      </div>
    </div>
  );
};

export default Hero;