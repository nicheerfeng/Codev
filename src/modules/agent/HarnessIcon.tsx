import { memo, useId } from "react";
import type { Harness } from "./types";

type IconProps = {
  size?: number | string;
};

const baseSvgStyle = { flex: "none", lineHeight: 1 } as const;

/** Pi (Codeg-adapted brand icon) */
const PiColorIcon = memo(function PiColorIcon({ size = 14 }: IconProps) {
  return (
    <svg
      height={size}
      style={baseSvgStyle}
      viewBox="0 0 24 24"
      width={size}
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <rect width="24" height="24" rx="5.3" fill="#000000" />
      <g fill="#FFFFFF" transform="translate(0.922 0.922) scale(0.027693)">
        <path
          fillRule="evenodd"
          d="M165.29 165.29H517.36V400H400V517.36H282.65V634.72H165.29ZM282.65 282.65V400H400V282.65Z"
        />
        <path d="M517.36 400H634.72V634.72H517.36Z" />
      </g>
    </svg>
  );
});

/** Codex (Codeg-adapted brand icon) */
const CodexColorIcon = memo(function CodexColorIcon({ size = 14 }: IconProps) {
  const id = useId();
  return (
    <svg
      height={size}
      style={baseSvgStyle}
      viewBox="2 2 20 20"
      width={size}
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path
        d="M9.064 3.344a4.578 4.578 0 012.285-.312c1 .115 1.891.54 2.673 1.275.01.01.024.017.037.021a.09.09 0 00.043 0 4.55 4.55 0 013.046.275l.047.022.116.057a4.581 4.581 0 012.188 2.399c.209.51.313 1.041.315 1.595a4.24 4.24 0 01-.134 1.223.123.123 0 00.03.115c.594.607.988 1.33 1.183 2.17.289 1.425-.007 2.71-.887 3.854l-.136.166a4.548 4.548 0 01-2.201 1.388.123.123 0 00-.081.076c-.191.551-.383 1.023-.74 1.494-.9 1.187-2.222 1.846-3.711 1.838-1.187-.006-2.239-.44-3.157-1.302a.107.107 0 00-.105-.024c-.388.125-.78.143-1.204.138a4.441 4.441 0 01-1.945-.466 4.544 4.544 0 01-1.61-1.335c-.152-.202-.303-.392-.414-.617a5.81 5.81 0 01-.37-.961 4.582 4.582 0 01-.014-2.298.124.124 0 00.006-.056.085.085 0 00-.027-.048 4.467 4.467 0 01-1.034-1.651 3.896 3.896 0 01-.251-1.192 5.189 5.189 0 01.141-1.6c.337-1.112.982-1.985 1.933-2.618.212-.141.413-.251.601-.33.215-.089.43-.164.646-.227a.098.098 0 00.065-.066 4.51 4.51 0 01.829-1.615 4.535 4.535 0 011.837-1.388zm3.482 10.565a.637.637 0 000 1.272h3.636a.637.637 0 100-1.272h-3.636zM8.462 9.23a.637.637 0 00-1.106.631l1.272 2.224-1.266 2.136a.636.636 0 101.095.649l1.454-2.455a.636.636 0 00.005-.64L8.462 9.23z"
        fill={`url(#${id})`}
      />
      <defs>
        <linearGradient
          gradientUnits="userSpaceOnUse"
          id={id}
          x1="12"
          x2="12"
          y1="3"
          y2="21"
        >
          <stop stopColor="#B1A7FF" />
          <stop offset=".5" stopColor="#7A9DFF" />
          <stop offset="1" stopColor="#3941FF" />
        </linearGradient>
      </defs>
    </svg>
  );
});

/** Antigravity (Codeg-adapted brand icon) */
const AntigravityMonoIcon = memo(function AntigravityMonoIcon({
  size = 14,
}: IconProps) {
  return (
    <svg
      fill="none"
      height={size}
      style={baseSvgStyle}
      viewBox="0 0 16 16"
      width={size}
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path
        d="M14.1452 14.6818C14.9937 15.3182 16.2664 14.894 15.0997 13.7273C11.5998 10.3333 12.3421 1 7.99366 1C3.64518 1 4.3876 10.3333 0.887603 13.7273C-0.385123 15 0.993664 15.3182 1.84215 14.6818C5.13002 12.4545 4.9179 8.5303 7.99366 8.5303C11.0694 8.5303 10.8573 12.4545 14.1452 14.6818Z"
        fill="currentColor"
      />
    </svg>
  );
});

const ClaudeCodeColorIcon = memo(function ClaudeCodeColorIcon({
  size = 14,
}: IconProps) {
  return (
    <svg
      height={size}
      style={baseSvgStyle}
      viewBox="0 0 24 24"
      width={size}
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path
        clipRule="evenodd"
        d="M20.998 10.949H24v3.102h-3v3.028h-1.487V20H18v-2.921h-1.487V20H15v-2.921H9V20H7.488v-2.921H6V20H4.487v-2.921H3V14.05H0V10.95h3V5h17.998v5.949zM6 10.949h1.488V8.102H6v2.847zm10.51 0H18V8.102h-1.49v2.847z"
        fill="#D97757"
        fillRule="evenodd"
      />
    </svg>
  );
});

const GeminiCliColorIcon = memo(function GeminiCliColorIcon({
  size = 14,
}: IconProps) {
  const id = useId();
  return (
    <svg
      height={size}
      style={baseSvgStyle}
      viewBox="0 0 24 24"
      width={size}
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path
        d="M0 4.391A4.391 4.391 0 014.391 0h15.217A4.391 4.391 0 0124 4.391v15.217A4.391 4.391 0 0119.608 24H4.391A4.391 4.391 0 010 19.608V4.391z"
        fill={`url(#${id})`}
      />
      <path
        clipRule="evenodd"
        d="M19.74 1.444a2.816 2.816 0 012.816 2.816v15.48a2.816 2.816 0 01-2.816 2.816H4.26a2.816 2.816 0 01-2.816-2.816V4.26A2.816 2.816 0 014.26 1.444h15.48zM7.236 8.564l7.752 3.728-7.752 3.727v2.802l9.557-4.596v-3.866L7.236 5.763v2.801z"
        fill="#1E1E2E"
        fillRule="evenodd"
      />
      <defs>
        <linearGradient
          gradientUnits="userSpaceOnUse"
          id={id}
          x1="24"
          x2="0"
          y1="6.587"
          y2="16.494"
        >
          <stop stopColor="#EE4D5D" />
          <stop offset=".328" stopColor="#B381DD" />
          <stop offset=".476" stopColor="#207CFE" />
        </linearGradient>
      </defs>
    </svg>
  );
});

const OpenCodeMonoIcon = memo(function OpenCodeMonoIcon({
  size = 14,
}: IconProps) {
  return (
    <svg
      fill="currentColor"
      fillRule="evenodd"
      height={size}
      style={baseSvgStyle}
      viewBox="0 0 24 24"
      width={size}
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path d="M16 6H8v12h8V6zm4 16H4V2h16v20z" />
    </svg>
  );
});

const ClineMonoIcon = memo(function ClineMonoIcon({ size = 14 }: IconProps) {
  return (
    <svg
      fill="currentColor"
      fillRule="evenodd"
      height={size}
      style={baseSvgStyle}
      viewBox="0 0 24 24"
      width={size}
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path d="M17.035 3.991c2.75 0 4.98 2.24 4.98 5.003v1.667l1.45 2.896a1.01 1.01 0 01-.002.909l-1.448 2.864v1.668c0 2.762-2.23 5.002-4.98 5.002H7.074c-2.751 0-4.98-2.24-4.98-5.002V17.33l-1.48-2.855a1.01 1.01 0 01-.003-.927l1.482-2.887V8.994c0-2.763 2.23-5.003 4.98-5.003h9.962zM8.265 9.6a2.274 2.274 0 00-2.274 2.274v4.042a2.274 2.274 0 004.547 0v-4.042A2.274 2.274 0 008.265 9.6zm7.326 0a2.274 2.274 0 00-2.274 2.274v4.042a2.274 2.274 0 104.548 0v-4.042A2.274 2.274 0 0015.59 9.6z" />
      <path d="M12.054 5.558a2.779 2.779 0 100-5.558 2.779 2.779 0 000 5.558z" />
    </svg>
  );
});

const CursorMonoIcon = memo(function CursorMonoIcon({ size = 14 }: IconProps) {
  return (
    <svg
      fill="currentColor"
      height={size}
      style={baseSvgStyle}
      viewBox="0 0 466.73 532.09"
      width={size}
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path d="M457.43,125.94L244.42,2.96c-6.84-3.95-15.28-3.95-22.12,0L9.3,125.94c-5.75,3.32-9.3,9.46-9.3,16.11v247.99c0,6.65,3.55,12.79,9.3,16.11l213.01,122.98c6.84,3.95,15.28,3.95,22.12,0l213.01-122.98c5.75-3.32,9.3-9.46,9.3-16.11v-247.99c0-6.65-3.55-12.79-9.3-16.11h-.01ZM444.05,151.99l-205.63,356.16c-1.39,2.4-5.06,1.42-5.06-1.36v-233.21c0-4.66-2.49-8.97-6.53-11.31L24.87,145.67c-2.4-1.39-1.42-5.06,1.36-5.06h411.26c5.84,0,9.49,6.33,6.57,11.39h-.01Z" />
    </svg>
  );
});

const GenericAcpIcon = memo(function GenericAcpIcon({ size = 14 }: IconProps) {
  return (
    <svg
      fill="none"
      height={size}
      style={baseSvgStyle}
      viewBox="0 0 24 24"
      width={size}
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <rect
        x="3"
        y="4"
        width="18"
        height="16"
        rx="4"
        stroke="currentColor"
        strokeWidth="1.8"
      />
      <path
        d="M8 9.5l3 2.5-3 2.5M12.5 14.5H16"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
});

function resolveHarnessGlyph(harnessId: string, harness?: Harness) {
  const hint = `${harnessId} ${harness?.displayName ?? ""} ${harness?.command ?? ""}`.toLowerCase();
  if (harnessId === "pi" || harness?.kind === "nativePi") {
    return PiColorIcon;
  }
  if (hint.includes("codex")) return CodexColorIcon;
  if (hint.includes("antigravity")) return AntigravityMonoIcon;
  if (hint.includes("claude")) return ClaudeCodeColorIcon;
  if (hint.includes("gemini")) return GeminiCliColorIcon;
  if (hint.includes("opencode")) return OpenCodeMonoIcon;
  if (hint.includes("cline")) return ClineMonoIcon;
  if (hint.includes("cursor")) return CursorMonoIcon;
  return GenericAcpIcon;
}

export function HarnessIcon({
  harnessId,
  harness,
  readOnly,
  size = 14,
  className = "",
}: {
  harnessId: string;
  harness?: Harness;
  readOnly?: boolean;
  size?: number;
  className?: string;
}) {
  const Glyph = resolveHarnessGlyph(harnessId, harness);
  const label = harness?.displayName ?? harnessId;
  const title = readOnly ? `${label}（只读历史）` : label;

  return (
    <span
      className={`agent-harness-icon ${readOnly ? "is-readonly" : ""} ${className}`.trim()}
      title={title}
      aria-label={title}
    >
      <Glyph size={size} />
    </span>
  );
}
