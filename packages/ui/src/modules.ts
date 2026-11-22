/**
 * The hub's modules. Each one is built in its own phase (see docs/ROADMAP.md);
 * until then it shows on the home page as coming soon, so the family can see
 * what is planned.
 */
import {
  BookUser,
  CalendarDays,
  ChefHat,
  FolderOpen,
  IdCard,
  ListChecks,
  Megaphone,
  PiggyBank,
  Wrench,
  type LucideIcon,
} from 'lucide-react'

export interface HubModule {
  id: string
  name: string
  path: string
  icon: LucideIcon
  description: string
  /** 'ready' modules are in the menu; 'next' is being built now; 'planned' is on the roadmap. */
  status: 'ready' | 'next' | 'planned'
  phase: number
  /** Shown to parents only. */
  parentsOnly?: boolean
}

export const MODULES: HubModule[] = [
  {
    id: 'files',
    name: 'Files',
    path: '/files',
    icon: FolderOpen,
    description: 'Important family documents, stored on your own server.',
    status: 'ready',
    phase: 1,
  },
  {
    id: 'info',
    name: 'Quick Info',
    path: '/info',
    icon: IdCard,
    description: 'ID and passport numbers, medical aid, vehicles and policies, end-to-end encrypted, to hand when you need them.',
    status: 'ready',
    phase: 2,
    parentsOnly: true,
  },
  {
    id: 'contacts',
    name: 'Contacts',
    path: '/contacts',
    icon: BookUser,
    description: 'The family address book: family and friends, school, doctors, insurers and trades, with emergency contacts.',
    status: 'ready',
    phase: 2,
    parentsOnly: true,
  },
  {
    id: 'calendar',
    name: 'Calendar',
    path: '/calendar',
    icon: CalendarDays,
    description: 'One family calendar: school, sport, appointments and birthdays, with reminders.',
    status: 'planned',
    phase: 3,
  },
  {
    id: 'lists',
    name: 'Lists & chores',
    path: '/lists',
    icon: ListChecks,
    description: 'Shopping lists, to-dos and a chore rota everyone can tick off.',
    status: 'planned',
    phase: 4,
  },
  {
    id: 'meals',
    name: 'Meals',
    path: '/meals',
    icon: ChefHat,
    description: 'Plan the week’s meals, keep favourite recipes, and send ingredients to the shopping list.',
    status: 'planned',
    phase: 5,
  },
  {
    id: 'board',
    name: 'Noticeboard',
    path: '/board',
    icon: Megaphone,
    description: 'Announcements and notes for the whole family, with push notifications.',
    status: 'planned',
    phase: 4,
  },
  {
    id: 'money',
    name: 'Bills & budget',
    path: '/money',
    icon: PiggyBank,
    description: 'Due dates for bills and renewals, and a simple shared budget.',
    status: 'planned',
    phase: 6,
  },
  {
    id: 'home',
    name: 'Home & car',
    path: '/home-care',
    icon: Wrench,
    description: 'Service dates, warranties, manuals and contacts for the house and cars.',
    status: 'planned',
    phase: 6,
  },
]
