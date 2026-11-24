/**
 * The emergency card (phase 5d): what a paramedic or a doctor at casualty
 * needs first, for each of the family. Shown on the phone from the locked
 * screen, with no network, after a fingerprint or face check.
 */
import { AlertTriangle, Phone, X } from 'lucide-react'
import { useState } from 'react'
import { Button } from '../ui.tsx'
import { ageText, type EmergencyCard } from './reports.ts'

const tel = (n: string) => `tel:${n.replace(/[^0-9+]/g, '')}`

export function EmergencyCardView({ cards, onClose }: { cards: EmergencyCard[]; onClose: () => void }) {
  const [index, setIndex] = useState(0)
  const card = cards[index] ?? cards[0]
  return (
    <div className="emergency" role="dialog" aria-modal="true" aria-label="Emergency card">
      <div className="emergency-top">
        <strong>Emergency card</strong>
        <Button variant="ghost" icon={<X size={20} aria-hidden />} aria-label="Close the emergency card" onClick={onClose} />
      </div>
      {cards.length > 1 && (
        <div className="row chips" role="group" aria-label="Whose card">
          {cards.map((c, i) => (
            <button key={c.name + i} className={`chip ${i === index ? 'chip-on' : ''}`} aria-pressed={i === index} onClick={() => setIndex(i)}>
              {c.name.split(' ')[0]}
            </button>
          ))}
        </div>
      )}
      {!card ? (
        <p>There is nobody on the card yet.</p>
      ) : (
        <div className="emergency-card">
          <h2>{card.name}</h2>
          <p className="muted">
            {[card.birthDate && `Born ${card.birthDate} (${ageText(card.birthDate, Date.now())})`, card.idNumber && `ID ${card.idNumber}`].filter(Boolean).join(' · ')}
          </p>

          {card.severeAllergies.length > 0 && (
            <div className="emergency-alert" role="alert">
              <AlertTriangle size={20} aria-hidden />
              <div>
                <strong>Severe allergies</strong>
                {card.severeAllergies.map((a) => (
                  <div key={a}>{a}</div>
                ))}
              </div>
            </div>
          )}

          <dl className="emergency-facts">
            <dt>Blood type</dt>
            <dd className="emergency-big">{card.bloodType || 'Not known'}</dd>
            {card.otherAllergies.length > 0 && (
              <>
                <dt>Other allergies</dt>
                <dd>{card.otherAllergies.join('; ')}</dd>
              </>
            )}
            {card.severeAllergies.length === 0 && card.otherAllergies.length === 0 && (
              <>
                <dt>Allergies</dt>
                <dd>None known</dd>
              </>
            )}
            <dt>Conditions</dt>
            <dd>{card.conditions.length ? card.conditions.join('; ') : 'None recorded'}</dd>
            <dt>Medicines</dt>
            <dd>{card.medicines.length ? card.medicines.map((m) => <div key={m}>{m}</div>) : 'None recorded'}</dd>
            {card.careNotes && (
              <>
                <dt>Care notes</dt>
                <dd className="pre-wrap">{card.careNotes}</dd>
              </>
            )}
            {card.medicalAid && (
              <>
                <dt>Medical aid</dt>
                <dd>
                  {[card.medicalAid.scheme, card.medicalAid.plan].filter(Boolean).join(' · ')}
                  {card.medicalAid.number && (
                    <div>
                      Number <strong>{card.medicalAid.number}</strong>
                      {card.medicalAid.dependantCode && `, dependant ${card.medicalAid.dependantCode}`}
                    </div>
                  )}
                  {card.medicalAid.phone && (
                    <a className="btn btn-secondary emergency-call" href={tel(card.medicalAid.phone)}>
                      <Phone size={16} aria-hidden /> <span>Call the scheme: {card.medicalAid.phone}</span>
                    </a>
                  )}
                </dd>
              </>
            )}
          </dl>

          {card.contacts.length > 0 && (
            <div className="stack-sm">
              <strong>Contacts</strong>
              {card.contacts.map((c) => (
                <div key={c.label + c.name} className="emergency-contact">
                  <div>
                    <div className="muted small">{c.label}</div>
                    <div>{c.name}</div>
                  </div>
                  {c.phone && (
                    <a className="btn btn-primary emergency-call" href={tel(c.phone)} aria-label={`Call ${c.name}, ${c.phone}`}>
                      <Phone size={16} aria-hidden /> <span>{c.phone}</span>
                    </a>
                  )}
                </div>
              ))}
            </div>
          )}
          <p className="muted small">Updated {new Date(card.updatedAt).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}. It is updated each time Health is opened on this phone.</p>
        </div>
      )}
    </div>
  )
}
