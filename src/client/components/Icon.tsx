const PATHS = {
  play: "M7 5.5v13l11-6.5z",
  pause: "M8 5h3v14H8zM13 5h3v14h-3z",
  stop: "M6.5 6.5h11v11h-11z",
  restart: "M4 12a8 8 0 1 0 2.4-5.7M4 4v4h4",
  rotate: "M20 12a8 8 0 1 1-2.4-5.7M20 4v4h-4",
  volume: "M4 9.5h3.5L12 6v12l-4.5-3.5H4zM15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11",
  mute: "M4 9.5h3.5L12 6v12l-4.5-3.5H4zM16 9.5l5 5M21 9.5l-5 5",
  history: "M4 12a8 8 0 1 0 2.4-5.7M4 4v4h4M12 8v4.5l3 2",
  info: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v5M12 7.6v.4",
  download: "M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19.5h14",
  upload: "M12 15.5V4.5M7.5 9 12 4.5 16.5 9M5 19.5h14",
  close: "M6 6l12 12M18 6 6 18",
  chevronLeft: "M14.5 6 8.5 12l6 6",
  chevronRight: "M9.5 6l6 6-6 6",
  swap: "M7 7h11l-3-3M17 17H6l3 3",
  check: "M5 12.5 10 17.5 19 7",
  gear: "M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4zM10.3 3h3.4l.5 2.4 1.6.9 2.3-.8 1.7 3-1.8 1.6v1.8l1.8 1.6-1.7 3-2.3-.8-1.6.9-.5 2.4h-3.4l-.5-2.4-1.6-.9-2.3.8-1.7-3L6 11.9v-1.8L4.2 8.5l1.7-3 2.3.8 1.6-.9z",
  eyeOff: "M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12zM4 20 20 4",
  alert: "M12 4 21 19.5H3zM12 10v4.5M12 17v.3",
  trash: "M5 7h14M10 7V5h4v2M7 7l1 12.5h8L17 7",
  eye: "M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  shield: "M12 3.5 19 6v5.5c0 4.2-3 7.4-7 9-4-1.6-7-4.8-7-9V6z",
  crosshair: "M12 20a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM12 2v5M12 17v5M2 12h5M17 12h5",
  move: "M12 3v18M3 12h18M12 3 9.5 5.5M12 3l2.5 2.5M12 21l-2.5-2.5M12 21l2.5-2.5M3 12l2.5-2.5M3 12l2.5 2.5M21 12l-2.5-2.5M21 12l-2.5 2.5",
  radar: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 16.5a4.5 4.5 0 1 0 0-9M12 12l6-6",
  skipBack: "M17.5 6v12L9 12zM6.5 6v12",
  skipForward: "M6.5 6v12L15 12zM17.5 6v12",
  flag: "M5.5 21V4M5.5 4.5h11l-2.5 4 2.5 4h-11",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 18, className }: { name: IconName; size?: number; className?: string }) {
  const filled = name === "play" || name === "pause" || name === "stop" || name === "skipBack" || name === "skipForward";
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      className={className}
      fill={filled ? "currentColor" : "none"}
      stroke={filled ? "none" : "currentColor"}
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
