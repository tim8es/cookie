# kuki — screen registry (D0 source snapshot)

**PROPOSED**, 2026-11-18 · #338. Source baseline main `e38443c6d83772041c726c79e5385bcc0f5e678c`. Companion [design foundation](design-foundation-roadmap-20261118.md).
IDs describe logical screens/states, not a commitment to separate routes. Grouped rows have a reserved stable ID per named logical flow; split with child suffixes without renumbering. A screen may share a component across surfaces. All statuses are source-level only; **visual acceptance and runtime checks NOT RUN for every row**.

Legend: **SOURCE** = real/staging composition or component observed in baseline; not functional or visual PASS. **LEGACY** = component referenced in historical guide; real composition not demonstrated. **PLANNED** = requirement or proposed UX, current real implementation not confirmed. **ACTIVE** = related open PR work; not merged evidence. Phase refers to design priority/related backlog, not authorization to implement early.

## Business workspace (owner/admin; permissions & organization scope server-owned)
| ID | Screen / use | Phase / Issue | Evidence / status | Design states to cover |
|---|---|---|---|---|
| B-01 | Sign-in, session and identity | F1 #309 | OwnerAuthGate.svelte SOURCE; #314/#330 ACTIVE | methods available, pending, denied/expired, logout, registration/recovery |
| B-02 | Choose/create organization; offer/trial and initial setup | F1/F2 #203/#27 | OnboardingScreen referenced in UI_GUIDE LEGACY; F0 map, Journey F PLANNED | no memberships, scope pick, draft, incomplete setup, offer acknowledgement, retry |
| B-03 | Overview and setup progress | F1 #203/#23 | RealOwnerOverviewPage.svelte SOURCE (import and branch) | incomplete setup, counters absent, ready, action shortcuts |
| B-04 | Business calendar day/week | F1 #23/#26 | RealOwnerCalendarPage.svelte SOURCE | empty, loading, multi-staff/time grid, mobile list, failed fetch, date/timezone |
| B-05 | Booking details / create / cancel / reschedule | F1/F2 #21/#23/#26/#285 | CalendarView/BookingDetail in UI_GUIDE LEGACY; actual mutation paths not verified | permission, confirmation, stale/occupied slot, policy, unknown result, retain prior booking on failed reschedule |
| B-06 | Services/prices list + editor | F1 #20/#26/#304 | RealOwnerServicesPage.svelte SOURCE | list empty, form validation, save pending, unknown creation result, price policy |
| B-07 | Staff directory/profile/service assignment | F1 #20/#26/#304 | RealOwnerStaffPage.svelte SOURCE; #306/#307 ACTIVE | create, edit, no service, draft/publish, scope, tier full; recovery |
| B-08 | Work schedule / exceptions / approval | F1/F2 #20/#26/#285 | RealOwnerSchedulePage.svelte SOURCE | empty, cross-location, overlap, draft/publish, approval mode, error |
| B-09 | Locations / branch details | F1 #20/#26/#304 | RealOwnerLocationsPage.svelte SOURCE | create/edit, timezone, no access, incomplete setup, uncertain result |
| B-10 | Appearance / public link / preview and publish | F1/F2 #223/#222 | RealOwnerAppearancePage.svelte SOURCE; implementation/gate not validated | preset, draft/preview/publish, upload error, contrast, reset, copy link |
| B-11 | public booking entry in workspace | F1 #222/#203 | navigation.ts booking label SOURCE; RealOwnerWorkspace renders unavailable page for booking | public URL, unavailable, safe external launch; no mock booking masquerading as real |
| B-12 | CRM client list and record | F2 #25/#26 | Journey/role requirements PLANNED | access-limited fields, history, search, no matches, privacy |
| B-13 | Role and permission management | F2 #26/#18 | #26 role label/type/location/permissions PLANNED | grant/revoke, restricted data, effective roles, unsaved state |
| B-14 | Discounts and promotion priority | F2 #28 | Journeys A7–A22 PLANNED | simple default setup, compatibility, ordering, preview, expired code |
| B-15 | Analytics | F2 #28 | #28 PLANNED | filter/date/branch, no data, snapshot revenue vs profit, limited scope |
| B-16 | Subscription/offer/expiry/export | F2/pilot #27/#35 | Journeys A25–A31 PLANNED | opt-in, trial remaining, expiry, old bookings accessible, tier upgrade, export |
| B-17 | Settings/business policy | F1/F2 #285 | accepted configurable policy requirement; UI not verified PLANNED | scoped owner changes, missing policy, validation, save/audit, forbidden |
| B-18 | XLSX/CSV import/export | F2 #252 | Journey F2/D3 and DEC-116 PLANNED | upload, template, preview, errors, confirm, retry and export |
| B-19 | Staff workspace and own calendar | F2 #26 | F0 role map / Journey D,D2 PLANNED | own shifts/visits, permission-limited data, multiple branches, change request |
| B-20 | Navigation shell | F1/F2 #13/#26 | Sidebar.svelte SOURCE desktop rail/mobile home/calendar/booking/more; navigation.ts | actor/tenant switch, active item, secondary sheet, keyboard, deep link/back/refresh |
| B-21 | Global operational states | F1 #203/#23 | OwnerAuthGate and RealOwnerUnavailablePage SOURCE | loading, forbidden, expired session, no organization context, runtime unreachable; preserve intent where safe |

## Customer and public booking
| ID | Screen / use | Phase / Issue | Evidence / status | Design states to cover |
|---|---|---|---|---|
| C-01 | Salon public page, service catalogue | F1/F2 #22/#23/#24/#222 | F0 map; PublicBookingHero/PublicHeader/BookingForm guide LEGACY; real public URL not verified in source slice | branch context, no catalogue, unavailable salon, accessible branding |
| C-02 | Service, branch and master selection | F1/F2 #23/#24 | BookingForm in UI_GUIDE LEGACY; Journey A/A4/A5 | clear price/duration, invalid combinations, changed selection, no services |
| C-03 | Date and available slot selection | F1/F2 #23/#24 | F0 journeys; BookingForm guide LEGACY | calendar/list, no slots, loading, timezone, occupied slot, refresh, retain selection |
| C-04 | Contact or verified identity | F1/F2 #25/#309 | StagingCustomerGate.svelte SOURCE, public guest verification not confirmed | phone/TG, pending/denied/expired, accessible validation, safe link |
| C-05 | Appointment summary / quote / submit | F1/F2 #23/#24/#28 | BookingSummary guide LEGACY; DEC-055 | itemized current server price vs preview, price changes, pending, conflict, unknown result |
| C-06 | Confirmation / receipt | F1 #23 | BookingConfirmation guide LEGACY | server-confirmed ID only, actual price, address/time, notification failure, management link |
| C-07 | Profile and booking history | F1/F2 #25/#336 | StagingCustomerGate imports StagingCustomerHistory and StagingCustomerOffers SOURCE; full public profile PLANNED | empty/past/upcoming, access denial, expired, loading, pagination, ownership |
| C-08 | View/manage individual booking | F1/F2 #21/#25/#285 | F0 map/Journey B3 PLANNED real path not inspected | time-only reschedule and cancel, deadline, conflict, unknown result, administrator handoff |
| C-09 | Repeat previous appointment | F2 #25 | Journey B PLANNED | retain previous selections only where still valid, current price/availability |
| C-10 | Account/link/identity preferences | F2 #25/#309 | Journey C2 PLANNED | existing link, safe verified linking, unlink/revoke, contact change |
| C-11 | Promo input/discount breakdown | F2 #28 | DEC-055/059/061 & Journeys A7–A22 PLANNED | invalid/expired code, incompatible, zero price, actual server result, rounding |
| C-12 | Booking restrictions/global feedback | F1/F2 #23/#25/#285 | StagingCustomerGate feedback SOURCE, broader public states PLANNED | expiry, network failure, no slots, insufficient access, error not false confirmation |

## Channels (adapters, not independent business logic)
| ID | Surface | Phase / Issue | Status | Design states to cover |
|---|---|---|---|---|
| X-01 | Mobile web | F1 #23 | Responsive style/Sidebar SOURCE, screenshots NOT RUN | 320/375 px, keyboard, calendar scroll, browser back |
| X-02 | iframe widget | F2 #24 | ADR-0005 PLANNED | host styles isolation, height, origin, blocked cookies, top-level fallback |
| X-03 | Telegram Mini App | F2 #24 | DESIGN.md preview-only LEGACY; real functionality not proven | initData pending/denied, safe areas, close/back, theme and compact states |
| X-04 | Telegram customer bot | F2/pilot #29 | Journey A24/C PLANNED | menu/FAQ, selection, confirmed, old callback, handoff, no LLM dependency |
| X-05 | Telegram admin mode | F2 #253 | Journey E2/DEC-116 PLANNED | explicit tenant/mode, calendar/visits, files, preview/confirm, revoked rights |

## Registry maintenance
Per ID, attach spec revision + Req/DEC links, checked route, actor/capability, evidence refs, design target, rendered screenshot and interaction SHA, issues/PRs and visual approval. Extend rows to cover sub-states only when meaningful; do not manufacture separate URLs or features. Existing F0 accepted product behavior and #203 constraints take precedence. D2 must resolve role visibility and precise navigation; D0 visual audit must replace SOURCE/LEGACY guesses with verified evidence, not promote all components automatically.
