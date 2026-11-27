// The landing page's mark (opencomputer.dev favicon): a stressed serif O on
// a paper tile, redrawn as vectors so it stays sharp at any size.
export function OpenComputerMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      className={className}
      role="img"
      aria-label="OpenComputer"
    >
      <rect
        x="0.75"
        y="0.75"
        width="30.5"
        height="30.5"
        rx="7"
        fill="#FAF8F5"
        stroke="#161513"
        strokeOpacity="0.12"
        strokeWidth="1.5"
      />
      <path
        fillRule="evenodd"
        fill="#161513"
        d="M16 5.7c-5.3 0-9.4 4.6-9.4 10.3S10.7 26.3 16 26.3s9.4-4.6 9.4-10.3S21.3 5.7 16 5.7Zm0 1c-2.6 0-4.2 4.1-4.2 9.3s1.6 9.3 4.2 9.3 4.2-4.1 4.2-9.3S18.6 6.7 16 6.7Z"
      />
    </svg>
  )
}
