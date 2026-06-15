import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Kinniburgh Finance",
    short_name: "KF Finance",
    description: "Personal & business financial management",
    start_url: "/",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#000000",
    icons: [{ src: "/icon.png", sizes: "512x512", type: "image/png" }],
  };
}
