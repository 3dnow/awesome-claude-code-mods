(() => {
  const q = document.getElementById('q')
  const count = document.getElementById('n')
  const tbody = document.querySelector('#t tbody')
  const rows = [...tbody.rows]
  const filters = [...document.querySelectorAll('.lv')]
  const reset = document.getElementById('reset')
  const results = document.getElementById('search-results')
  const clearSearch = document.getElementById('clear-search')
  let level = ''

  function apply() {
    const search = q.value.trim().toLowerCase()
    let visible = 0
    for (const row of rows) {
      row.hidden = !((level === '' || row.dataset.level === level) && (!search || row.dataset.name.toLowerCase().includes(search)))
      if (!row.hidden) visible++
    }
    count.textContent = visible === rows.length ? `${rows.length} mods` : `${visible} of ${rows.length} mods`
    for (const filter of filters) filter.setAttribute('aria-pressed', String(filter.dataset.level === level))
    reset.hidden = !search && !level
    results.hidden = !search
    clearSearch.hidden = q.value.length === 0
    results.firstChild.textContent = `View ${visible} matching ${visible === 1 ? 'mod' : 'mods'} `
    document.getElementById('empty').hidden = visible !== 0
  }

  function clear() {
    q.value = ''
    level = ''
    apply()
  }

  for (const filter of filters) filter.addEventListener('click', () => {
    level = level === filter.dataset.level ? '' : filter.dataset.level
    apply()
  })
  for (const button of document.querySelectorAll('#reset, [data-reset]')) button.addEventListener('click', () => {
    clear()
    document.querySelector('.lv.all').focus({ preventScroll: true })
  })
  q.addEventListener('input', apply)
  clearSearch.addEventListener('click', () => {
    q.value = ''
    apply()
    q.focus()
  })
  document.querySelector('.search').addEventListener('submit', event => {
    event.preventDefault()
    document.getElementById('directory').scrollIntoView()
    document.querySelector('.lv.all').focus({ preventScroll: true })
  })
  for (const button of document.querySelectorAll('#t th button')) button.addEventListener('click', () => {
    const key = button.dataset.k
    const direction = button.dataset.dir === 'asc' ? 'desc' : 'asc'
    document.querySelectorAll('#t th').forEach(th => th.removeAttribute('aria-sort'))
    button.dataset.dir = direction
    button.closest('th').setAttribute('aria-sort', direction === 'asc' ? 'ascending' : 'descending')
    rows.sort((a, b) => {
      const comparison = key === 'stars' ? Number(a.dataset.stars) - Number(b.dataset.stars) : key === 'level' ? Number(a.dataset.level) - Number(b.dataset.level) || Number(b.dataset.stars) - Number(a.dataset.stars) : a.dataset.name.localeCompare(b.dataset.name)
      return direction === 'asc' ? comparison : -comparison
    })
    tbody.append(...rows)
  })

  function reveal(id, scroll = true) {
    const row = document.getElementById(id)
    if (!row || !rows.includes(row)) return
    clear()
    if (scroll) row.scrollIntoView({ block: 'center' })
    row.querySelector('.mod-name').focus({ preventScroll: true })
  }
  for (const segment of document.querySelectorAll('.seg')) segment.addEventListener('click', event => {
    event.preventDefault()
    history.replaceState(null, '', segment.getAttribute('href'))
    reveal(segment.hash.slice(1))
  })
  window.addEventListener('hashchange', () => reveal(location.hash.slice(1)))
  const query = new URLSearchParams(location.search).get('q')
  if (query) q.value = query
  apply()
  if (location.hash) reveal(location.hash.slice(1))
})()
