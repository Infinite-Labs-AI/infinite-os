"use client"

export default function Login() {
  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const response = await fetch("/api/auth/login", { method: "POST", body: JSON.stringify(Object.fromEntries(form)) })
    if (response.ok) window.location.assign("/")
  }
  return (
    <form onSubmit={onSubmit}>
      <input name="email" type="email" />
      <input name="password" type="password" />
      <button type="submit">Log in</button>
    </form>
  )
}
