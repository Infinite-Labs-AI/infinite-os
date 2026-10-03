"use client"

export default function Signup() {
  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const response = await fetch("/api/signup", { method: "POST", body: JSON.stringify(Object.fromEntries(form)) })
    if (response.ok) window.location.assign("/")
  }
  return (
    <form onSubmit={onSubmit}>
      <input name="email" type="email" />
      <input name="password" type="password" />
      <button type="submit">Create account</button>
    </form>
  )
}
