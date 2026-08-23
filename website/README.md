# Emma website

Public landing page for Emma. The site is self-contained in this directory: it
has its own `package-lock.json` and is not part of any root workspace, so run
every command from `website/`.

React 19, Tailwind 4, and TypeScript on Vite 8. It is a single page:
`src/main.tsx` mounts `src/App.tsx` into `index.html`, and `src/index.css`
holds the Tailwind import and global styles.

## Development

Requires Node.js 20.19+ or 22.13+ (Vite 8 wants 20.19+ or 22.12+, ESLint 10
wants 20.19+, 22.13+, or 24+). There is no `engines` field enforcing this.

```sh
npm install
npm run dev
```

## Checks

```sh
npm run format:check   # or: npm run format, to rewrite
npm run lint
npm run typecheck
npm run build
```

`npm run check` runs `format:check`, `lint`, and `build`; `build` runs `tsc -b`
first, so it covers `typecheck`.

## Output

`npm run build` writes the static bundle to `dist/`, which is gitignored. The
repository contains no CI workflow or host configuration for this site, so
deployment is done outside of it.
