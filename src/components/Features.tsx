import React, { MouseEvent, ReactElement, useRef, useState } from "react";

interface bentoProsp {
  src: string;
  title: ReactElement;
  description: string;
}

interface bentoTiltProps {
  children: React.ReactNode;
  className?: string;
}

const BentoTilt = ({ children, className = "" }: bentoTiltProps) => {
  const [transformStyle, setTransformStyle] = useState<string>("");

  const itemRef = useRef<HTMLDivElement | null>(null);

  const handleMouseMove = (e: MouseEvent) => {
    if (!itemRef.current) return;

    const { left, top, width, height } =
      itemRef.current.getBoundingClientRect();

    const relativeX = (e.clientX - left) / width;
    const relativeY = (e.clientY - top) / height;

    const tiltX = (relativeX - 0.5) * 50;
    const tiltY = (relativeY - 0.5) * -50;
    const newTransform = `perspective(700px) rotateX(${tiltX}deg) rotateY(${tiltY}deg) scale3d(0.98, 0.98, 0.98 )`;

    setTransformStyle(newTransform);
  };

  const handleMouseLeave = () => {
    setTransformStyle("");
  };

  return (
    <div
      className={`${className} duration-[0.2s]`}
      ref={itemRef}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      style={{ transform: transformStyle }}
    >
      {children}
    </div>
  );
};

const BentoCard = ({ src, title, description }: bentoProsp) => {
  return (
    <div className="relative size-full">
      <video
        src={src}
        loop
        muted
        autoPlay
        className="absolute left-0 top-0 size-full object-cover object-center"
      />
      <div className="relative z-10 flex size-full flex-col justify-between p-5 text-blue-50">
        <div>
          <h1 className="bento-title special-font">{title}</h1>
          {description && (
            <p className="mt-3 max-w-64 text-xs md:text-base">{description}</p>
          )}
        </div>
      </div>
    </div>
  );
};

const Features = () => {
  return (
    <section id="features" className="bg-black pb-0">
      <div className="container mx-auto px-3 md:px-10">
        {/* Scrolling Text Section */}
        <div className="py-32">
          {/* Static centered text – MARAD */}
          <p className="font-circular-web text-lg text-blue-50 text-center mb-8">
            A Senkisem nem csak egy Márka.
          </p>

          {/* Scrolling animated text – ELTŰNIK */}
          <div className="relative overflow-hidden hidden">
            <div className="flex whitespace-nowrap animate-scroll">
              {[...Array(3)].map((_, i) => (
                <div key={i} className="flex items-center">
                  <h2 className="font-circular-web text-4xl md:text-6xl text-blue-50 mx-8">
                    ÜZENET.
                  </h2>
                  <h2 className="font-circular-web text-4xl md:text-6xl text-blue-50 mx-8">
                    MOZGALOM.
                  </h2>
                  <h2 className="font-circular-web text-4xl md:text-6xl text-blue-50 mx-8">
                    EMLÉKEZTETŐ.
                  </h2>
                </div>
              ))}
            </div>
          </div>
        </div>

        <BentoTilt className="border-hsla relative mb-7 h-96 w-full overflow-hidden rounded-md md:h-[65vh]">
          <BentoCard
            src="videos/feature-6.mp4"
            title={
              <>
                Már<b>ka</b>bolt
              </>
            }
            description="Minden darab egy történet. Minden történet egy élmény. Nem logókat viselsz – hanem üzeneteket."
          />
        </BentoTilt>

        <div className="grid h-[135vh] grid-cols-2 grid-rows-3 gap-7">
          {/* Jegyzetek Egy Idegentől */}
          <BentoTilt className="bento-tilt_1 row-span-1 md:col-span-1 md:row-span-2">
            <BentoCard
              src="videos/hero-3.mp4"
              title={
                <>
                  Jegyzetek<b> Egy</b> Idegentől
                </>
              }
              description="Egy idegen jegyzetei, aki talán épp ugyan azon, ment keresztül, mint te. Vagy Pont máson. De ez most nem számít. Mert ez a könyv nem rólam szól... Rólad."
            />
          </BentoTilt>

          {/* Használati Útmutató Az Élethez */}
          <BentoTilt className="bento-tilt_1 row-span-1 ms-32 md:col-span-1 md:ms-0">
            <div className="relative size-full">
              <video
                src="videos/feature-3.mp4"
                loop
                muted
                autoPlay
                className="absolute left-0 top-0 size-full object-contain object-right"
                style={{
                  objectPosition: '80% center',
                  transform: 'scale(0.7)',
                  transformOrigin: 'right center'
                }}
              />
              <div className="relative z-10 flex size-full flex-col justify-between p-5 text-blue-50">
                <div>
                  <h1 className="bento-title special-font">
                    Használati Útmutató <br /> Az Élethez
                  </h1>
                  <p className="mt-3 max-w-64 text-xs md:text-base">
                    A Jegyzetek folytatása. Valódi olvasói válaszok alapján készült rendszerdiagnosztika. Nem megoldásokat ad : állapotot jelez. Senkisem módra
                  </p>
                </div>
              </div>
            </div>
          </BentoTilt>

          {/* Valami Új Jön */}
          <BentoTilt className="bento-tilt_1 me-14 md:col-span-1 md:me-0">
            <BentoCard
              src="videos/feature-4.mp4"
              title={
                <>
                  Valami <b></b>Új Jön
                </>
              }
              description="?????????"
            />
          </BentoTilt>
        </div>
      </div>

      {/* CSS Animation */}
      <style>
{`
  @keyframes scrollLeft {
    0% { transform: translateX(0); }
    100% { transform: translateX(-33.333%); }
  }
`}
</style>
    </section>
  );
};

export default Features;