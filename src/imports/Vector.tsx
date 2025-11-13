import svgPaths from "./svg-doblkg1lj9";

export default function Vector() {
  return (
    <div className="relative size-full" data-name="Vector">
      <div className="absolute inset-[-30.6%_-18.66%_-61.2%_-18.66%]">
        <svg className="block size-full" fill="none" preserveAspectRatio="none" viewBox="0 0 89 51">
          <g filter="url(#filter0_di_10_199)" id="Vector">
            <path d={svgPaths.p913f540} fill="var(--fill-0, white)" />
            <path d={svgPaths.p25037700} fill="var(--fill-0, white)" />
            <path d={svgPaths.p3a456d00} fill="var(--fill-0, white)" />
          </g>
          <defs>
            <filter colorInterpolationFilters="sRGB" filterUnits="userSpaceOnUse" height="50.1444" id="filter0_di_10_199" width="88.3043" x="0" y="2.34343e-08">
              <feFlood floodOpacity="0" result="BackgroundImageFix" />
              <feColorMatrix in="SourceAlpha" result="hardAlpha" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0" />
              <feOffset dy="4" />
              <feGaussianBlur stdDeviation="6" />
              <feComposite in2="hardAlpha" operator="out" />
              <feColorMatrix type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.25 0" />
              <feBlend in2="BackgroundImageFix" mode="normal" result="effect1_dropShadow_10_199" />
              <feBlend in="SourceGraphic" in2="effect1_dropShadow_10_199" mode="normal" result="shape" />
              <feColorMatrix in="SourceAlpha" result="hardAlpha" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0" />
              <feOffset dy="4" />
              <feGaussianBlur stdDeviation="2" />
              <feComposite in2="hardAlpha" k2="-1" k3="1" operator="arithmetic" />
              <feColorMatrix type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.25 0" />
              <feBlend in2="shape" mode="normal" result="effect2_innerShadow_10_199" />
            </filter>
          </defs>
        </svg>
      </div>
    </div>
  );
}