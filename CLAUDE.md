# CLAUDE.md - AI Assistant Guide

## Project Overview
RegenHub Boulder is a landing page for a cooperative workspace in Boulder, CO. The site promotes community, economic democracy, and regenerative technology.

## Tech Stack
- **Frontend**: React 18, TypeScript 5, Vite 5
- **UI**: Tailwind CSS, shadcn/ui (49 components), Radix UI
- **Deployment**: GitHub Pages with PR previews
- **Design**: Custom "Forest Through Glass" glassmorphism theme

## Key Files
- `src/components/RegenHubLanding.tsx` - Main landing page (447 lines)
- `src/index.css` - Global styles and design system
- `.github/workflows/` - CI/CD pipelines

## Development Commands
```bash
pnpm install     # Install dependencies
pnpm run dev     # Start dev server on :8080
pnpm run build   # Build for production
pnpm run lint    # Run ESLint
```

## Testing
Run tests and linting before committing:
```bash
pnpm run lint
pnpm run build
```

## Design System
- **Colors**: Forest green (#2d5a3d), Sage (#a8c09a), Gold (#e8b04b)
- **Effects**: Glassmorphism with backdrop blur
- **Animations**: Sway, fade-in-up, hover effects
- **Font**: Inter (Google Fonts)

## External Integrations
- **Airtable**: Member directory and applications
- **Luma**: Event calendar
- **Contact**: boulder.regenhub@gmail.com
- **Telegram**: Community chat

## Deployment
- **Production**: Pushes to main deploy to GitHub Pages
- **PR Previews**: Auto-deploy to `/pr-{number}/`
- **Custom Domain**: Configure in public/CNAME

## Common Tasks

### Add new section to landing page
Edit `src/components/RegenHubLanding.tsx`

### Update colors/theme
Modify CSS variables in `src/index.css`

### Add new route
Update `src/App.tsx` and create page in `src/pages/`

### Deploy changes
Push to main branch - GitHub Actions handles deployment

## Project Structure
```
src/
├── assets/        # Images (forest-background.jpg, mascot.png)
├── components/
│   ├── ui/        # shadcn components
│   └── RegenHubLanding.tsx
├── pages/         # Route components
├── hooks/         # Custom hooks
├── lib/           # Utilities
└── App.tsx        # Router
```

## Important Notes
- Single page application with client-side routing
- GitHub Pages requires 404.html for SPA support
- PR preview workflow uses JamesIves/github-pages-deploy-action
- All content in one component for simplicity

## Contact
For questions about the codebase: boulder.regenhub@gmail.com
