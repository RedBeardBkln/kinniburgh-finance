import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

const eslintConfig = [
  ...nextCoreWebVitals,
  ...nextTypescript,
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "out/**",
      "build/**",
      "next-env.d.ts",
    ],
  },
  {
    rules: {
      // On-mount sync (localStorage/sessionStorage hydration, OAuth redirect
      // restore, auto-send OTP, fetch-on-open modals) is intentional here.
      // New code should prefer deriving state or fetching in effects callbacks.
      "react-hooks/set-state-in-effect": "warn",
    },
  },
];

export default eslintConfig;
