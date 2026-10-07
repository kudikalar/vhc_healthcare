// Small stroke icon set (24px grid, currentColor) used by navigation and page chrome.
const P = {
  home: 'M3 10.5 12 3l9 7.5M5 9.5V21h5v-6h4v6h5V9.5',
  explore: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM15.5 8.5l-2 5-5 2 2-5 5-2z',
  family: 'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6M16 4.3a3.5 3.5 0 0 1 0 6.4M18 14.4c2.1.7 3.5 2.8 3.5 5.6',
  shield: 'M12 3 4.5 6v5.5c0 4.6 3.2 8.3 7.5 9.5 4.3-1.2 7.5-4.9 7.5-9.5V6L12 3zM9 12l2 2 4-4',
  claim: 'M20.8 8.6a5.3 5.3 0 0 0-9-3.4l-.8.8-.8-.8a5.3 5.3 0 0 0-7.5 7.5L12 21l7.3-8.3M3.5 12h4l1.5-3 3 6 1.5-3h3',
  hospital: 'M4 21V7l8-4 8 4v14M2 21h20M12 8v6M9 11h6M9.5 21v-3.5h5V21',
  card: 'M3 6h18v12H3zM3 10h18M7 15h3',
  file: 'M14 3H6v18h12V7l-4-4zM14 3v4h4M9 13h6M9 17h6',
  help: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6M12 17h.01',
  bell: 'M6 9a6 6 0 1 1 12 0c0 6 2.5 7.5 2.5 7.5h-17S6 15 6 9zM10 20a2 2 0 0 0 4 0',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21c0-4 3.6-6.5 8-6.5s8 2.5 8 6.5',
  calc: 'M6 3h12v18H6zM9 7h6M9 12h.01M12 12h.01M15 12h.01M9 16h.01M12 16h.01M15 16h.01',
  clipboard: 'M9 4h6v3H9zM9 5.5H6V21h12V5.5h-3M9 12h6M9 16h4',
  work: 'M4 7h16v13H4zM9 7V4h6v3M4 12h16',
  alert: 'M12 4 2.5 20h19L12 4zM12 10v4.5M12 17.5h.01',
  chart: 'M4 20V4M4 20h16M8 16v-5M12 16V8M16 16v-3',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 13.5l1.6 1.2-2 3.4-1.9-.7a7 7 0 0 1-2 1.2L14.8 21h-4l-.3-2.4a7 7 0 0 1-2-1.2l-1.9.7-2-3.4 1.6-1.2a7 7 0 0 1 0-2.3L4.6 10l2-3.4 1.9.7a7 7 0 0 1 2-1.2L10.8 3h4l.3 2.1a7 7 0 0 1 2 1.2l1.9-.7 2 3.4-1.6 1.2a7 7 0 0 1 0 2.3z',
  refresh: 'M20 11a8 8 0 0 0-14.8-3.5M4 4v4h4M4 13a8 8 0 0 0 14.8 3.5M20 20v-4h-4',
  layers: 'M12 3 2.5 8l9.5 5 9.5-5L12 3zM2.5 13l9.5 5 9.5-5',
  payout: 'M3 7h18v10H3zM12 14.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM6 10v4M18 10v4',
  dove: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v10M7 12h10',
  menu: 'M4 6h16M4 12h16M4 18h16',
  close: 'M6 6l12 12M18 6 6 18',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  phone: 'M5 3h4l2 5-2.5 1.5a11 11 0 0 0 6 6L16 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 5a2 2 0 0 1 2-2z',
  offline: 'M2 8.5a15 15 0 0 1 5-3M22 8.5a15 15 0 0 0-10-3.5M5 12.5a10 10 0 0 1 3.5-2.2M19 12.5a10 10 0 0 0-4-2.4M8.5 16a5 5 0 0 1 7 0M12 20h.01M3 3l18 18',
  logout: 'M15 4h4v16h-4M10 8l-4 4 4 4M6 12h11',
  chevron: 'M9 6l6 6-6 6',
};

export default function Icon({ name, size = 20, className = '', title }) {
  return (
    <svg className={`icon ${className}`} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden={title ? undefined : 'true'} role={title ? 'img' : undefined}>
      {title && <title>{title}</title>}
      <path d={P[name] || P.more} />
    </svg>
  );
}
