/*
 * Plain `.css` side-effect imports (`import "./landing.css"`), which Next bundles. TypeScript 6 (the version VS Code
 * ships) turns `noUncheckedSideEffectImports` on by default and reports TS2882 "Cannot find module or type declarations
 * for side-effect import" on each one without this. No exports: CSS here is imported for its side effect only.
 */
declare module "*.css" {}
