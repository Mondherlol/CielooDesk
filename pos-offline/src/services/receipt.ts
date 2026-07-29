// Rendu du ticket de caisse hors-ligne — miroir TypeScript du renderer PHP du
// Ticket Designer (receipts/lib/receipt_designer_renderer.lib.php). Le layout
// vient du snapshot (template affecté à 'vente') ; chaque bloc reproduit le
// même HTML/styles inline que son équivalent PHP pour un ticket identique.
//
// Blocs non pertinents hors-ligne (nacef_*, table_number, stock_reason,
// section_name) : rendus vides. Code-barres de la réf : non rendu (JsBarcode
// indisponible), la réf texte est affichée à la place.

import type { Catalog, OfflineSale, ReceiptBlock, ReceiptInfo } from '../types'
import { formatAmount, formatPrice } from './catalog'

// Layout par défaut = cieloodesigner_default_layout() (blocs NACEF omis).
function defaultLayout(): ReceiptBlock[] {
    return [
        { type: 'logo', visible: true, align: 'center', width: 60, margin_top: 2, margin_bottom: 6 },
        { type: 'company_name', visible: true, align: 'center', font_size: 22, bold: true, margin_bottom: 3 },
        { type: 'address', visible: true, align: 'center', font_size: 16, margin_bottom: 3 },
        { type: 'separator', style: 'solid', margin_top: 5, margin_bottom: 5 },
        { type: 'transaction_type', visible: true, align: 'center', font_size: 22, bold: true, margin_bottom: 4 },
        { type: 'reference', visible: true, align: 'center', font_size: 17, bold: true, margin_bottom: 2 },
        { type: 'datetime', visible: true, align: 'center', font_size: 15, show_terminal: true, margin_bottom: 3 },
        { type: 'customer', visible: true, align: 'right', font_size: 16, prefix: 'Client : ', hide_default: true, margin_bottom: 3 },
        { type: 'header_text', visible: true, align: 'center', font_size: 15, margin_bottom: 3 },
        { type: 'separator', style: 'dashed', margin_top: 4, margin_bottom: 4 },
        { type: 'items_table', show_qty: true, show_unit_price: true, show_ttc: true, show_currency: false, show_article_count: true, font_size: 17, margin_bottom: 2 },
        { type: 'separator', style: 'solid', margin_top: 4, margin_bottom: 4 },
        { type: 'totals', show_ttc: true, bold_ttc: true, font_size: 17, margin_bottom: 4 },
        { type: 'vat_table', visible: true, grouped: true, font_size: 15, margin_bottom: 4 },
        { type: 'payments', visible: true, show_change: true, align: 'right', font_size: 17, bold: true, margin_bottom: 4 },
        { type: 'separator', style: 'dashed', margin_top: 4, margin_bottom: 5 },
        { type: 'text', visible: true, align: 'center', font_size: 16, content: 'Merci de votre visite !', margin_bottom: 3 },
        { type: 'footer_text', visible: true, align: 'center', font_size: 15, margin_bottom: 4 },
    ]
}

const EMPTY_RECEIPT: ReceiptInfo = {
    layout: [],
    company: { name: '', address: '', zip: '', town: '', mf: '' },
    warehouse: { name: '', address: '', address2: '', city: '', zip: '', mf: '' },
    logo: '',
    header_text: '',
    footer_text: '',
    terminal: '',
    terminal_name: '',
}

function esc(s: unknown): string {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function nl2br(s: string): string {
    return s.replace(/\r?\n/g, '<br>')
}

function num(v: unknown, fallback: number): number {
    const n = Number(v)
    return Number.isFinite(n) ? n : fallback
}

function bool(v: unknown, fallback: boolean): boolean {
    return v === undefined || v === null ? fallback : Boolean(v)
}

/** Équivalent de cieloodesigner_css_block(). */
function cssBlock(b: ReceiptBlock): string {
    const align = (b.align as string) ?? 'center'
    const fs = num(b.font_size, 14)
    const color = (b.color as string) ?? '#000000'
    const mt = num(b.margin_top, 0)
    const mb = num(b.margin_bottom, 5)
    const fw = b.bold ? '700' : '600'
    return `text-align:${align};font-size:${fs}px;line-height:1.45;font-weight:${fw};color:${color};margin-top:${mt}px;margin-bottom:${mb}px;`
}

interface RenderCtx {
    sale: OfflineSale
    info: ReceiptInfo
    currency: string
    tokens: Record<string, string>
}

function collectTokens(sale: OfflineSale, info: ReceiptInfo, currency: string): Record<string, string> {
    const companyName = info.warehouse.name || info.company.name
    const addrParts = info.warehouse.address || info.warehouse.city
        ? [info.warehouse.address, info.warehouse.address2, `${info.warehouse.zip} ${info.warehouse.city}`.trim()]
        : [info.company.address, `${info.company.zip} ${info.company.town}`.trim()]
    const companyAddress = addrParts.filter(Boolean).join(', ')
    const mf = info.warehouse.mf || info.company.mf
    const cashier = sale.user?.name || sale.user?.login || ''
    const d = new Date(sale.created_at)
    const date = d.toLocaleDateString('fr-FR')
    const time = d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
    const totalHt = sale.lines.reduce((s, l) => s + l.total_ttc / (1 + l.tva_tx / 100), 0)

    return {
        client: sale.customer?.name ?? '', customer: sale.customer?.name ?? '',
        societe: companyName, company_name: companyName,
        adresse: companyAddress, address: companyAddress,
        mf, tax_number: mf,
        reference: sale.ref, ref: sale.ref,
        type_ticket: 'VENTE', transaction_type: 'VENTE',
        date, heure: time, time, datetime: `${date} ${time}`,
        caissier: cashier, cashier,
        terminal: info.terminal, caisse: info.terminal,
        currency, devise: currency,
        total_ht: formatPrice(totalHt, currency),
        total_tva: formatPrice(sale.total_ttc - totalHt, currency),
        total_ttc: formatPrice(sale.total_ttc, currency),
        timbre: formatPrice(0, currency),
        warehouse: info.warehouse.name, store: info.warehouse.name,
    }
}

function replaceTokens(text: string, tokens: Record<string, string>): string {
    if (!text.includes('{')) return text
    return text.replace(/\{([a-zA-Z0-9_:]+)\}/g, (m, key: string) => tokens[key.toLowerCase()] ?? m)
}

// ─── Blocs ──────────────────────────────────────────────────────────────────

function renderLogo(b: ReceiptBlock, ctx: RenderCtx): string {
    if (!ctx.info.logo) return ''
    const width = Math.min(num(b.width, 80), 100)
    const align = (b.align as string) ?? 'center'
    const filter = b.bw_logo ? 'filter:grayscale(100%) brightness(0.55) contrast(2.8);' : ''
    const marginX = align === 'center' ? 'margin-left:auto;margin-right:auto;'
        : align === 'right' ? 'margin-left:auto;margin-right:0;' : 'margin-left:0;margin-right:auto;'
    return `<div style="margin-top:${num(b.margin_top, 0)}px;margin-bottom:${num(b.margin_bottom, 5)}px;overflow:hidden;">`
        + `<img src="${ctx.info.logo}" style="display:block;width:${width}px;max-width:calc(100% - 20px);height:auto;object-fit:contain;${marginX}${filter}" alt="logo"></div>`
}

function renderCompanyName(b: ReceiptBlock, ctx: RenderCtx): string {
    const name = b.use_warehouse && ctx.info.warehouse.name ? ctx.info.warehouse.name : ctx.info.company.name
    if (!name) return ''
    return `<div style="${cssBlock(b)}">${esc(name)}</div>`
}

function renderAddress(b: ReceiptBlock, ctx: RenderCtx): string {
    const wh = ctx.info.warehouse
    const co = ctx.info.company
    const useWh = Boolean(b.use_warehouse) && (wh.address !== '' || wh.city !== '')
    let inner = ''
    if (useWh) {
        if (wh.address) inner += esc(wh.address) + '<br>'
        if (wh.address2) inner += esc(wh.address2) + '<br>'
        const zc = `${wh.zip} ${wh.city}`.trim()
        if (zc) inner += esc(zc) + '<br>'
    } else {
        if (co.address) inner += esc(co.address) + '<br>'
        const zc = `${co.zip} ${co.town}`.trim()
        if (zc) inner += esc(zc) + '<br>'
    }
    if (!inner) return ''
    return `<div style="${cssBlock(b)}">${inner}</div>`
}

function renderTaxNumber(b: ReceiptBlock, ctx: RenderCtx): string {
    const mf = b.use_warehouse && ctx.info.warehouse.mf ? ctx.info.warehouse.mf : ctx.info.company.mf
    if (!mf) return ''
    return `<div style="${cssBlock(b)}">${esc((b.prefix as string) ?? 'MF : ')}${esc(mf)}</div>`
}

function renderSeparator(b: ReceiptBlock): string {
    const style = (b.style as string) ?? 'solid'
    const mt = num(b.margin_top, 5)
    const mb = num(b.margin_bottom, 5)
    if (style === 'space') {
        return `<div style="height:${num(b.height, 0) || 12}px;margin-top:${mt}px;margin-bottom:${mb}px;"></div>`
    }
    const borders: Record<string, string> = { solid: '1px solid #000', dashed: '1px dashed #555', dotted: '1px dotted #555', double: '3px double #000' }
    return `<hr style="border:none;border-top:${borders[style] ?? '1px solid #000'};margin:${mt}px ${num(b.padding, 0)}px ${mb}px;">`
}

function renderReference(b: ReceiptBlock, ctx: RenderCtx): string {
    // Pas de JsBarcode hors-ligne : on affiche toujours la réf en texte.
    return `<div style="${cssBlock(b)}">${esc(ctx.sale.ref)}</div>`
}

function renderDatetime(b: ReceiptBlock, ctx: RenderCtx): string {
    const d = new Date(ctx.sale.created_at)
    const dateText = `${d.toLocaleDateString('fr-FR')} ${d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`
    if (b.show_terminal && ctx.info.terminal !== '' && ctx.info.terminal !== '0') {
        const label = ctx.info.terminal_name || `${(b.terminal_label as string) ?? 'Caisse'} ${ctx.info.terminal}`
        return `<div style="${cssBlock(b)}">${esc(dateText)}-${esc(label)}</div>`
    }
    return `<div style="${cssBlock(b)}">${esc(dateText)}</div>`
}

function renderCashier(b: ReceiptBlock, ctx: RenderCtx): string {
    const name = ctx.sale.user?.name || ctx.sale.user?.login || ''
    if (!name) return ''
    return `<div style="${cssBlock(b)}">${esc((b.prefix as string) ?? 'Caissier : ')}${esc(name)}</div>`
}

function renderCustomer(b: ReceiptBlock, ctx: RenderCtx): string {
    // Offline : client passager = pas de client → équivaut au hide_default du PHP.
    if (!ctx.sale.customer) return ''
    return `<div style="${cssBlock(b)}">${esc((b.prefix as string) ?? 'Client : ')}${esc(ctx.sale.customer.name)}</div>`
}

function renderFreeText(b: ReceiptBlock, ctx: RenderCtx): string {
    const content = replaceTokens(String(b.content ?? ''), ctx.tokens).trim()
    if (!content) return ''
    return `<div style="${cssBlock(b)}">${nl2br(esc(content))}</div>`
}

function renderText(b: ReceiptBlock, ctx: RenderCtx): string {
    const content = replaceTokens(String(b.content ?? ''), ctx.tokens)
    if (!content) return ''
    const text = b.html ? content : nl2br(esc(content))
    return `<div style="${cssBlock(b)}">${text}</div>`
}

function renderHeaderText(b: ReceiptBlock, ctx: RenderCtx): string {
    const text = replaceTokens(ctx.info.header_text, ctx.tokens)
    if (!text) return ''
    return `<div style="${cssBlock(b)}">${nl2br(text)}</div>`
}

function renderFooterText(b: ReceiptBlock, ctx: RenderCtx): string {
    const text = replaceTokens(ctx.info.footer_text, ctx.tokens)
    if (!text) return ''
    return `<div style="${cssBlock(b)}">${nl2br(text)}</div>`
}

// ─── Tableau articles ───────────────────────────────────────────────────────
// Miroir de cieloodesigner_visible_item_columns_with_percent + render_items_table.

interface ItemColumn {
    key: string
    visible: boolean
    title: string
    template: string | null
    font_size: number
    bold: boolean
    width_percent: number
}

function itemColumns(b: ReceiptBlock): ItemColumn[] {
    const fs = num(b.font_size, 13)
    const defaults: Omit<ItemColumn, 'width_percent'>[] = [
        { key: 'qty', visible: bool(b.show_qty, true), title: 'Qté', template: null, font_size: fs, bold: Boolean(b.bold) },
        { key: 'label', visible: true, title: 'Article', template: '{product_label}', font_size: fs, bold: Boolean(b.bold) },
        { key: 'unit_price', visible: bool(b.show_unit_price, true), title: 'P.U.', template: null, font_size: fs, bold: Boolean(b.bold) },
        { key: 'total_ht', visible: Boolean(b.show_ht), title: 'HT', template: null, font_size: fs, bold: Boolean(b.bold) },
        { key: 'total_ttc', visible: bool(b.show_ttc, true), title: 'TTC', template: null, font_size: fs, bold: Boolean(b.bold) },
    ]
    const allowed = new Set(defaults.map((c) => c.key))
    const incoming = Array.isArray(b.item_columns) ? (b.item_columns as Array<Record<string, unknown>>) : []
    const result = new Map<string, Omit<ItemColumn, 'width_percent'>>()
    for (const col of incoming) {
        const key = String(col.key ?? '')
        if (!allowed.has(key) || result.has(key)) continue
        result.set(key, {
            key,
            visible: bool(col.visible, true),
            title: String(col.title ?? ''),
            template: key === 'label' ? String(col.template ?? '{product_label}') : null,
            font_size: num(col.font_size, 0) || fs,
            bold: Boolean(col.bold),
        })
    }
    for (const col of defaults) if (!result.has(col.key)) result.set(col.key, col)

    const visible = [...result.values()].filter((c) => c.visible)
    const fixed: Record<string, number> = { qty: 12, unit_price: 21, total_ht: 16, total_ttc: 19 }
    const reserved = visible.reduce((s, c) => s + (fixed[c.key] ?? 0), 0)
    const labelWidth = Math.max(30, 100 - reserved)
    return visible.map((c) => ({ ...c, width_percent: c.key === 'label' ? labelWidth : (fixed[c.key] ?? 0) }))
}

function renderItemsTable(b: ReceiptBlock, ctx: RenderCtx): string {
    const columns = itemColumns(b)
    const showCurrency = bool(b.show_currency, true)
    const showArtCount = Boolean(b.show_article_count)
    const fs = num(b.font_size, 13)
    const fw = b.bold ? '700' : '500'
    const cur = ctx.currency
    const rightKeys = new Set(['unit_price', 'total_ht', 'total_ttc'])

    let html = `<div style="margin-top:${num(b.margin_top, 0)}px;margin-bottom:${num(b.margin_bottom, 0)}px;overflow:hidden;">`
    html += `<table style="width:100%;border-collapse:collapse;font-size:${fs}px;font-weight:${fw};line-height:1.3;table-layout:fixed;">`

    html += '<thead><tr>'
    for (const col of columns) {
        const align = rightKeys.has(col.key) ? 'right' : 'left'
        const colFs = fs > 12 ? fs - 1 : fs
        html += `<th style="width:${col.width_percent.toFixed(2)}%;padding:2px 3px 4px;border-bottom:2px solid #000;text-align:${align};font-size:${colFs}px;font-weight:700;overflow:hidden;white-space:nowrap;">${esc(col.title)}</th>`
    }
    html += '</tr></thead><tbody>'

    let count = 0
    for (const line of ctx.sale.lines) {
        count++
        const unitTtc = line.qty !== 0 ? line.total_ttc / line.qty : line.total_ttc
        html += '<tr>'
        for (const col of columns) {
            const align = rightKeys.has(col.key) ? 'right' : 'left'
            let value = ''
            if (col.key === 'qty') value = `${line.qty}x`
            if (col.key === 'label') {
                const rendered = (col.template ?? '{product_label}')
                    .replace(/\{([a-zA-Z0-9_]+)\}/g, (_m, key: string) => {
                        switch (key.toLowerCase()) {
                            case 'product_ref': return line.ref
                            case 'product_label': case 'product_description': return line.label
                            case 'qty': return `${line.qty}x`
                            case 'unit_price': return formatAmount(unitTtc, cur)
                            case 'total_ttc': return formatAmount(line.total_ttc, cur)
                            case 'total_ht': return formatAmount(line.total_ttc / (1 + line.tva_tx / 100), cur)
                            default: return ''
                        }
                    })
                value = esc(rendered.replace(/\s+/g, ' ').trim())
                // invoice.php:4809-4810 : badge de remise ligne à côté du libellé.
                if (line.discount_percent > 0) {
                    value += `<span class="pos-discount-badge">-${line.discount_percent}%</span>`
                }
            }
            if (col.key === 'unit_price') value = formatAmount(unitTtc, cur) + (showCurrency ? `&nbsp;${esc(cur)}` : '')
            if (col.key === 'total_ht') value = formatAmount(line.total_ttc / (1 + line.tva_tx / 100), cur) + (showCurrency ? `&nbsp;${esc(cur)}` : '')
            if (col.key === 'total_ttc') value = formatAmount(line.total_ttc, cur) + (showCurrency ? `&nbsp;${esc(cur)}` : '')
            const cellStyle = col.key === 'label' ? 'overflow-wrap:anywhere;word-break:break-word;' : 'white-space:nowrap;overflow:hidden;'
            html += `<td style="width:${col.width_percent.toFixed(2)}%;padding:4px 3px;text-align:${align};font-size:${col.font_size}px;font-weight:${col.bold ? '700' : fw};${cellStyle}">${value}</td>`
        }
        html += '</tr>'
    }

    if (showArtCount && count > 0) {
        html += `<tr><td colspan="${columns.length}" style="padding:4px 3px 2px;text-align:right;font-size:${Math.max(10, fs - 2)}px;color:#444;font-style:italic;border-top:1px solid #aaa;">Nb articles : ${count}</td></tr>`
    }
    return html + '</tbody></table></div>'
}

function renderTotals(b: ReceiptBlock, ctx: RenderCtx): string {
    const showHt = Boolean(b.show_ht)
    const showTva = Boolean(b.show_tva)
    const showTtc = bool(b.show_ttc, true)
    const boldTtc = bool(b.bold_ttc, true)
    const fs = num(b.font_size, 14)
    const fsTtc = num(b.font_size_ttc, Math.max(fs + 3, 17))
    const fw = b.bold ? '700' : '500'
    const cur = ctx.currency
    const totalHt = ctx.sale.lines.reduce((s, l) => s + l.total_ttc / (1 + l.tva_tx / 100), 0)

    let html = `<div style="margin-top:${num(b.margin_top, 0)}px;margin-bottom:${num(b.margin_bottom, 0)}px;">`
    const hasSub = showHt || showTva
    if (hasSub) {
        html += `<table style="width:100%;border-collapse:collapse;font-size:${fs}px;font-weight:${fw};">`
        if (showHt) html += `<tr><td style="padding:2px 4px;width:55%;">Total HT</td><td style="padding:2px 4px;text-align:right;">${formatPrice(totalHt, cur)}</td></tr>`
        if (showTva) html += `<tr><td style="padding:2px 4px;">TVA</td><td style="padding:2px 4px;text-align:right;">${formatPrice(ctx.sale.total_ttc - totalHt, cur)}</td></tr>`
        html += '</table>'
    }
    if (showTtc) {
        const ttcFw = boldTtc ? '800' : '600'
        html += `<table style="width:100%;border-collapse:collapse;border-top:2px solid #000;border-bottom:2px solid #000;margin:${hasSub ? 4 : 0}px 0 2px;">`
        html += `<tr><td style="padding:5px 4px;font-size:${fsTtc}px;font-weight:${ttcFw};width:55%;">TOTAL&nbsp;TTC</td>`
        html += `<td style="padding:5px 4px;text-align:right;font-size:${fsTtc}px;font-weight:${ttcFw};">${formatPrice(ctx.sale.total_ttc, cur)}</td></tr></table>`
    }
    return html + '</div>'
}

function renderVatTable(b: ReceiptBlock, ctx: RenderCtx): string {
    const fs = num(b.font_size, 12)
    const fw = b.bold ? '700' : '500'
    const cur = ctx.currency

    const groups = new Map<number, { ht: number; tva: number }>()
    for (const line of ctx.sale.lines) {
        const ht = line.total_ttc / (1 + line.tva_tx / 100)
        const g = groups.get(line.tva_tx) ?? { ht: 0, tva: 0 }
        g.ht += ht
        g.tva += line.total_ttc - ht
        groups.set(line.tva_tx, g)
    }

    let html = `<div style="margin:${num(b.margin_top, 5)}px auto ${num(b.margin_bottom, 5)}px;width:90%;font-size:${fs}px;line-height:1.3;">`
    html += `<table style="width:100%;border-collapse:collapse;font-weight:${fw};">`
    html += '<thead><tr><th style="border-bottom:1px solid #000;padding:2px 4px;">Taux</th>'
        + '<th style="border-bottom:1px solid #000;padding:2px 4px;text-align:right;">Base HT</th>'
        + '<th style="border-bottom:1px solid #000;padding:2px 4px;text-align:right;">TVA</th></tr></thead><tbody>'
    for (const [rate, vals] of [...groups.entries()].sort((a, b2) => a[0] - b2[0])) {
        html += `<tr><td style="padding:2px 4px;">${esc(String(rate))}%</td>`
            + `<td style="text-align:right;padding:2px 4px;">${formatPrice(vals.ht, cur)}</td>`
            + `<td style="text-align:right;padding:2px 4px;">${formatPrice(vals.tva, cur)}</td></tr>`
    }
    return html + '</tbody></table></div>'
}

function renderPayments(b: ReceiptBlock, ctx: RenderCtx): string {
    const showChange = bool(b.show_change, true)
    const fs = num(b.font_size, 14)
    const fw = b.bold ? '700' : '500'
    const align = (b.align as string) ?? 'left'
    const cur = ctx.currency
    const pay = ctx.sale.payment

    const label = pay.method === 'cash' ? 'Espèces' : 'Carte bancaire'
    // Comme le POS online : la ligne espèces affiche le montant reçu.
    const amount = pay.method === 'cash' && pay.received !== null ? pay.received : ctx.sale.total_ttc

    let html = `<div style="margin-top:${num(b.margin_top, 5)}px;margin-bottom:${num(b.margin_bottom, 5)}px;">`
    html += `<table style="width:100%;border-collapse:collapse;font-size:${fs}px;font-weight:${fw};text-align:${align};">`
    html += `<tr><td style="padding:3px 4px;width:55%;">${esc(label)}</td>`
        + `<td style="padding:3px 4px;text-align:right;">${formatPrice(amount, cur)}</td></tr>`
    if (showChange && pay.change !== null && pay.change > 0) {
        html += `<tr><td style="padding:3px 4px;font-style:italic;color:#555;">Rendu</td>`
            + `<td style="padding:3px 4px;text-align:right;font-style:italic;color:#555;">${formatPrice(pay.change, cur)}</td></tr>`
    }
    return html + '</table></div>'
}

// ─── Assemblage ─────────────────────────────────────────────────────────────

function renderBlock(b: ReceiptBlock, ctx: RenderCtx): string {
    if (b.visible === false) return ''
    switch (b.type) {
        case 'logo': return renderLogo(b, ctx)
        case 'company_name': return renderCompanyName(b, ctx)
        case 'address': return renderAddress(b, ctx)
        case 'tax_number': return renderTaxNumber(b, ctx)
        case 'separator': return renderSeparator(b)
        case 'transaction_type': return `<div style="${cssBlock(b)}">VENTE</div>`
        case 'reference': return renderReference(b, ctx)
        case 'datetime': return renderDatetime(b, ctx)
        case 'cashier': return renderCashier(b, ctx)
        case 'customer': return renderCustomer(b, ctx)
        case 'free_text': return renderFreeText(b, ctx)
        case 'header_text': return renderHeaderText(b, ctx)
        case 'items_table': return renderItemsTable(b, ctx)
        case 'totals': return renderTotals(b, ctx)
        case 'vat_table': return renderVatTable(b, ctx)
        case 'payments': return renderPayments(b, ctx)
        case 'text': return renderText(b, ctx)
        case 'footer_text': return renderFooterText(b, ctx)
        default: return '' // nacef_*, table_number, stock_reason, section_name… : sans objet hors-ligne
    }
}

// CSS identique à receipt_designer.php (impression thermique 80mm).
const TICKET_CSS = `
@page { size: 80mm auto; margin: 0 !important; }
html { margin: 0; padding: 0; width: 80mm; background: #fff; }
body { margin: 0; padding: 0; width: 80mm; background: #fff; print-color-adjust: exact; -webkit-print-color-adjust: exact; }
.ticket { width: 80mm; max-width: 80mm; padding: 3mm 3mm 6mm 3mm; margin: 0; font-family: 'Arial', 'Helvetica Neue', Helvetica, sans-serif; font-size: 13px; line-height: 1.3; color: #000; background: #fff; box-sizing: border-box; -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility; }
.ticket * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.ticket img { max-width: 100%; display: block; image-rendering: -webkit-optimize-contrast; image-rendering: crisp-edges; }
.ticket table { max-width: 100%; border-collapse: collapse; table-layout: fixed; word-break: break-word; }
.ticket td, .ticket th { overflow-wrap: anywhere; word-break: break-word; vertical-align: middle; }
.ticket p, .ticket div { overflow-wrap: anywhere; word-break: break-word; }
.pos-discount-badge { margin-left: 4px; font-size: 0.85em; font-weight: 700; color: #c05000; }
@media print {
  @page { size: 80mm auto; margin: 0; }
  html, body { width: 80mm !important; max-width: 80mm !important; overflow: hidden !important; margin: 0 !important; padding: 0 !important; background: #fff !important; -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
  .ticket * { color: #000 !important; background: transparent !important; }
  .ticket hr { border-color: #000 !important; }
}
@media screen {
  body { background: #f0f0f0; width: auto; }
  .ticket { width: 80mm; max-width: 80mm; min-height: 50mm; box-shadow: 0 2px 12px rgba(0,0,0,.12); }
}
`

/** Document HTML complet du ticket, prêt à imprimer (data URL ou fenêtre). */
export function renderReceiptHtml(sale: OfflineSale, catalog: Catalog): string {
    const info: ReceiptInfo = catalog.receipt ?? EMPTY_RECEIPT
    const layout = info.layout.length > 0 ? info.layout : defaultLayout()
    const currency = sale.currency || catalog.currency
    const ctx: RenderCtx = { sale, info, currency, tokens: collectTokens(sale, info, currency) }

    const body = layout.map((b) => renderBlock(b, ctx)).join('\n')
    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>${TICKET_CSS}</style></head><body><div class="ticket">${body}</div></body></html>`
}
