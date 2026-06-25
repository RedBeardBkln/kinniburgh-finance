import { redirect } from "next/navigation";
import type { Route } from "next";

export default function PersonalProjectsRedirect() {
  redirect("/projects" as Route);
}
