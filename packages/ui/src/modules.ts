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
  HeartPulse,
  IdCard,
  ListChecks,
  Megaphone,
  PiggyBank,
  GraduationCap,
  Gift,
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
    description: 'One family calendar: everyone’s plans tagged by person, birthdays from Contacts, school and holidays, with reminders.',
    status: 'ready',
    phase: 4,
  },
  {
    id: 'health',
    name: 'Health',
    path: '/health',
    icon: HeartPulse,
    description: 'Each person’s allergies, medicines, conditions, history and doctors, end-to-end encrypted, with an emergency card on the phone.',
    status: 'ready',
    phase: 5,
    parentsOnly: true,
  },
  {
    id: 'lists',
    name: 'Lists & chores',
    path: '/lists',
    icon: ListChecks,
    description: 'Shopping lists, to-dos and a chore rota everyone can tick off.',
    status: 'planned',
    phase: 11,
  },
  {
    id: 'meals',
    name: 'Meals',
    path: '/meals',
    icon: ChefHat,
    description: 'Plan the week’s meals, keep favourite recipes, and send ingredients to the shopping list.',
    status: 'planned',
    phase: 12,
  },
  {
    id: 'board',
    name: 'Noticeboard',
    path: '/board',
    icon: Megaphone,
    description: 'Announcements and notes for the whole family, with push notifications.',
    status: 'planned',
    phase: 11,
  },
  {
    id: 'money',
    name: 'Bills & budget',
    path: '/money',
    icon: PiggyBank,
    description: 'Bills, subscriptions and invoices with due dates and renewal deadlines; the budget comes next.',
    status: 'ready',
    phase: 6,
    parentsOnly: true,
  },
  {
    id: 'home',
    name: 'Home & car',
    path: '/home-care',
    icon: Wrench,
    description: 'Vehicle services, warranties and manuals, maintenance that comes back, and the tradespeople worth calling again.',
    status: 'ready',
    phase: 6,
    parentsOnly: true,
  },
  {
    id: 'school',
    name: 'School',
    path: '/school',
    icon: GraduationCap,
    description: 'A page per child: school dates, contacts, extra-murals, reminders, fees and costs, and documents, tied into the calendar and budget.',
    status: 'ready',
    phase: 7,
    parentsOnly: true,
  },
  {
    id: 'wishlists',
    name: 'Wishlists',
    path: '/wishlists',
    icon: Gift,
    description: 'Everyone’s wishlist, with “I’m getting this” kept secret from them; share links for the children’s lists; the gift planner.',
    status: 'planned',
    phase: 8,
  },
]
