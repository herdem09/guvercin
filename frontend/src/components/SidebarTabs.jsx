import './SidebarTabs.css'

export default function SidebarTabs({ tabs, activeTab, onTabSelect }) {
  return (
    <nav className="sidebar-tabs" aria-label="Ana bölümler">
      <ul>
        {tabs.map((tab) => (
          <li key={tab.id} className={tab.id === activeTab ? 'active' : ''}>
            <button
              type="button"
              className="sidebar-tab-btn"
              onClick={() => onTabSelect(tab.id)}
            >
              <span className="sidebar-tab-icon" aria-hidden="true">
                {tab.icon}
              </span>
              <span className="sidebar-tab-label">{tab.label}</span>
            </button>
          </li>
        ))}
      </ul>
    </nav>
  )
}
