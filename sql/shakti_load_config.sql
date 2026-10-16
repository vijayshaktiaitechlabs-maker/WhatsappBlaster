-- Load Shakti Sports Club's bot content onto their tenant row.
-- Run in Supabase → SQL Editor (after shakti_setup.sql).
-- Safe & additive: touches only the Shakti tenant, nothing of Orena's.

update tenants
set bot_config = $${
  "brand": {
    "name": "Shakti Sports Club",
    "tagline": "Where Athletes become Champions",
    "greeting": "🏆 Welcome to Shakti Sports Club!\nWhere athletes become champions. I can help you with membership, court & cafe bookings, and upcoming events. What would you like to do?",
    "menu_button": "Menu"
  },
  "menu": [
    { "id": "menu:membership", "title": "Membership",          "desc": "Plans, benefits & how to join" },
    { "id": "menu:book",       "title": "Book a Court",         "desc": "Reserve a court" },
    { "id": "menu:cafe",       "title": "Cafe Reservation",     "desc": "Book a table at the cafe" },
    { "id": "menu:events",     "title": "Events & Tournaments", "desc": "Register for events & workshops" },
    { "id": "menu:offers",     "title": "Membership Offers",    "desc": "Current exclusive offers" },
    { "id": "menu:human",      "title": "Talk to Team",         "desc": "Speak to our staff" }
  ],
  "pricing_text": "💠 *Membership Plans*\n• TODO: Plan A — ₹____/year\n• TODO: Plan B — ₹____/year\nTap *Talk to Team* for a personalised quote or a club tour.",
  "offers_text": "🎁 *Current Offers*\n• TODO: add current offers.\nTap *Membership* to see plans.",
  "human_handoff": "✅ A Shakti Sports Club team member will reach out shortly. You can also call us on +91 88669 48999.",
  "contact": {
    "address": "B/s. Shakti Greens and Banquet, Near Bright Day School, Vasna-Bhayli Road, Vadodara - 391410",
    "phone": "+91 8866948999",
    "email": "info@shaktisportsclub.com",
    "website": "www.shaktisportsclub.com"
  }
}$$::jsonb
where slug = 'shakti';
