// Clients créés hors-ligne. Persistés par le shell (customers.json dans
// userData) quand il est là, sinon localStorage (dev navigateur). Ils portent
// un id négatif jusqu'à leur création réelle côté Dolibarr au rejeu.

import type { Customer } from '../types'

const LS_KEY = 'cieloo-offline-customers'

function readLocal(): Customer[] {
    try { return JSON.parse(localStorage.getItem(LS_KEY) ?? '[]') as Customer[] } catch { return [] }
}

export async function listLocalCustomers(): Promise<Customer[]> {
    const bridge = window.cielooOffline
    if (bridge?.listCustomers) {
        return (await bridge.listCustomers()) as Customer[]
    }
    return readLocal()
}

export async function createLocalCustomer(name: string, phone: string, email: string): Promise<Customer> {
    const bridge = window.cielooOffline
    if (bridge?.saveCustomer) {
        const res = await bridge.saveCustomer({ name, phone, email })
        if (!res.ok || !res.customer) throw new Error(res.error ?? 'Échec de la création du client.')
        return res.customer as Customer
    }
    const customer: Customer = {
        id: -Date.now(),
        name: name.trim(),
        code_client: null,
        phone: phone.trim() || null,
        email: email.trim() || null,
        points: null,
        local: true,
    }
    if (customer.name === '') throw new Error('Le nom du client est obligatoire.')
    localStorage.setItem(LS_KEY, JSON.stringify([...readLocal(), customer]))
    return customer
}
