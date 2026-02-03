import { useEffect, useState, useRef } from "react";
import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/all";

gsap.registerPlugin(ScrollTrigger);

const Hero = () => {
  const [showScrollHint, setShowScrollHint] = useState(false);
  const [videoStartTime, setVideoStartTime] = useState<number | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const checkLoading = () => {
      if ((window as any).loadingDone && videoRef.current) {
        videoRef.current.play().catch(() => {});
        setVideoStartTime(Date.now());
      } else {
        requestAnimationFrame(checkLoading);
      }
    };
    checkLoading();
  }, []);

  useEffect(() => {
    if (videoStartTime) {
      const timer = setTimeout(() => setShowScrollHint(true), 5000);
      return () => clearTimeout(timer);
    }
  }, [videoStartTime]);

  useGSAP(() => {
    if (showScrollHint) {
      gsap.fromTo(
        "#scroll-hint",
        { opacity: 0, y: 20 },
        { opacity: 1, y: 0, duration: 1.5, ease: "power2.out" }
      );
    }
  }, [showScrollHint]);

  useGSAP(() => {
    gsap.set("#video-frame", {
      clipPath: "polygon(14% 0%, 72% 0%, 88% 90%, 0% 95%)",
      borderRadius: "0 0 10% 10%",
    });

    gsap.from("#video-frame", {
      clipPath: "polygon(0% 0%, 100% 0%, 100% 100%, 0% 100%)",
      borderRadius: "0 0 0 0",
      scrollTrigger: {
        trigger: "#video-frame",
        start: "center center",
        end: "bottom center",
        scrub: true,
      },
    });
  });

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
          className="
            absolute inset-0
            w-full h-full
            object-cover
            bg-black
            md:absolute md:left-1/2 md:top-1/2
            md:-translate-x-1/2 md:-translate-y-1/2
            md:w-[140%] md:h-[70%]
            md:object-fill
          "
        />

        {/* SCROLL HINT */}
        {showScrollHint && (
          <div className="pointer-events-none absolute bottom-8 left-1/2 z-50 -translate-x-1/2">
            <p
              id="scroll-hint"
              className="text-sm font-light tracking-wide text-neutral-300"
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