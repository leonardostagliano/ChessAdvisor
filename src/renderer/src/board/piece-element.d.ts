import 'react'

// chessground renders pieces as `<piece class="white queen">`; the promotion picker reuses the
// same element so the bundled piece set styles it.
declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      piece: React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement>
    }
  }
}
