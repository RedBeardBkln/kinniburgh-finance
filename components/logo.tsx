import { cn } from "@/lib/utils";

export function BananaIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 40 40"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      {/* Main banana body — diagonal crescent from lower-left to upper-right */}
      <path
        d="M 5 32 C 1 18, 16 2, 34 6 C 26 14, 14 24, 5 32 Z"
        fill="currentColor"
      />
      {/* Belly highlight for dimension */}
      <path
        d="M 9 23 C 7 14, 18 6, 29 8"
        stroke="white"
        strokeWidth="1.5"
        strokeLinecap="round"
        opacity="0.35"
      />
      {/* Left stem */}
      <path
        d="M 5 32 C 4 33, 3 35, 2 36"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        opacity="0.55"
      />
      {/* Right tip */}
      <path
        d="M 34 6 C 35 5, 36 3, 37 3"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        opacity="0.55"
      />
    </svg>
  );
}

interface BananaLogoProps {
  size?: "sm" | "md" | "lg";
  className?: string;
}

export function BananaLogo({ size = "md", className }: BananaLogoProps) {
  const sizes = {
    sm: { icon: "h-5 w-5", text: "text-sm" },
    md: { icon: "h-7 w-7", text: "text-base" },
    lg: { icon: "h-12 w-12", text: "text-2xl" },
  };
  const { icon, text } = sizes[size];

  return (
    <div className={cn("flex items-center gap-2", className)}>
      <BananaIcon className={cn(icon, "text-primary")} />
      <span className={cn("font-bold tracking-tight text-foreground", text)}>
        Banana Stand
      </span>
    </div>
  );
}
