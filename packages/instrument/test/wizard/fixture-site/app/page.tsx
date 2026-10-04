import Link from "next/link"

export default function Home() {
  return (
    <main>
      <h1>Acme Store</h1>
      <Link href="/signup">Start free trial</Link>
      <Link href="/pricing">Pricing</Link>
      <Link href="/login">Log in</Link>
    </main>
  )
}
