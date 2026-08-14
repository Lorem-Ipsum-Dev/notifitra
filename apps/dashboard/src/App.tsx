const NAV_ITEMS = ["Notifications", "Templates", "Keys", "Dead-letter"] as const;

export function App() {
  return (
    <div
      style={{
        fontFamily: "system-ui, sans-serif",
        maxWidth: "48rem",
        margin: "0 auto",
        padding: "2rem",
      }}
    >
      <h1>Notifitra Admin</h1>
      <p>Dashboard placeholder. Feature views land in Phase 6/7.</p>
      <nav>
        <ul>
          {NAV_ITEMS.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </nav>
    </div>
  );
}
