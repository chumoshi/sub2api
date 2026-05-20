/**
 * 首页 SEO：更新 title、description 与 Open Graph 标签。
 */

function upsertMeta(attr: 'name' | 'property', key: string, content: string): void {
  if (!content) return
  const selector = `meta[${attr}="${key}"]`
  let el = document.head.querySelector<HTMLMetaElement>(selector)
  if (!el) {
    el = document.createElement('meta')
    el.setAttribute(attr, key)
    document.head.appendChild(el)
  }
  el.setAttribute('content', content)
}

function upsertCanonical(href: string): void {
  if (!href) return
  let el = document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]')
  if (!el) {
    el = document.createElement('link')
    el.setAttribute('rel', 'canonical')
    document.head.appendChild(el)
  }
  el.setAttribute('href', href)
}

function resolveAbsoluteUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path
  const origin = window.location.origin
  return `${origin}${path.startsWith('/') ? path : `/${path}`}`
}

export interface HomeSeoOptions {
  title: string
  description: string
  siteName: string
  image?: string
  locale?: 'zh' | 'en'
  keywords?: string
}

export function setHomePageSeo(options: HomeSeoOptions): void {
  const { title, description, siteName, image, locale, keywords } = options

  const ogLocale = locale === 'en' ? 'en_US' : 'zh_CN'
  const htmlLang = locale === 'en' ? 'en' : 'zh-CN'
  document.documentElement.setAttribute('lang', htmlLang)

  document.title = title
  upsertMeta('name', 'description', description)
  if (keywords) {
    upsertMeta('name', 'keywords', keywords)
  }
  upsertMeta('property', 'og:type', 'website')
  upsertMeta('property', 'og:locale', ogLocale)
  upsertMeta('property', 'og:title', title)
  upsertMeta('property', 'og:description', description)
  upsertMeta('property', 'og:site_name', siteName)
  upsertMeta('name', 'twitter:card', 'summary_large_image')
  upsertMeta('name', 'twitter:title', title)
  upsertMeta('name', 'twitter:description', description)

  const canonical = resolveAbsoluteUrl('/home')
  upsertCanonical(canonical)
  upsertMeta('property', 'og:url', canonical)

  if (image) {
    const imageUrl = resolveAbsoluteUrl(image)
    upsertMeta('property', 'og:image', imageUrl)
    upsertMeta('name', 'twitter:image', imageUrl)
  }
}
