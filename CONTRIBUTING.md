# Contributing to ours.network

Thank you for your interest in ours.network. We welcome bug reports, feature discussion, documentation fixes, and code contributions.

## Before you start

- **Bug reports and ideas:** open an issue. Please include reproduction steps and your environment.
- **Security issues:** do **not** open a public issue — see [SECURITY.md](./SECURITY.md).
- **Code and documentation patches:** require a signed contribution agreement (CLA) — see below. Until the CLA process is live, we are accepting **issues and feedback only**, not pull requests.

## The CLA, and why we require it

ours.network is licensed under the Functional Source License (FSL-1.1-Apache-2.0): source-available today and converting to Apache 2.0 in the future, with paid commercial licences available for organisations that need terms beyond the FSL. The commercial licences are what fund full-time maintenance of this project.

For that model to work, Adapt Framework Solutions Ltd needs sufficient rights in
external contributions. The proposed contribution agreement combines assignment
of specified rights with broad licensing, including commercial relicensing.
See [Contribution rights and acceptance](#contribution-rights-and-acceptance) for
the draft terms, their limits and the required signing process. External pull
requests remain on hold while that process is pending. Issues and discussion are
welcome without signing; patches offered for incorporation need the agreement.

## Pull request guidelines

1. Open or comment on an issue first for anything non-trivial, so we can agree the approach before you write code.
2. Keep PRs focused — one change per PR.
3. Include tests for behavioural changes and update documentation affected by your change.
4. Once intake opens, complete the signed agreement and verify coverage for every PR (see Required acceptance before merge below).
5. Use clear commit messages; reference the issue number.

## Code of conduct

Be kind, be constructive, assume good faith. Maintainers may close issues or PRs that don't follow these guidelines.

## Contribution rights and acceptance

**Policy draft v1 — 2026-09-24; not yet activated.** The proposed recipient is
**Adapt Framework Solutions Ltd** (the Company), as named in the existing project
documents. The Owner must confirm its full legal identity and counsel must approve
the agreement and acceptance process before external pull requests reopen.
This notice does not itself establish that a contributor has signed an assignment.

### What a pull request would mean

Once the approved agreement and acceptance process are live, submitting a pull
request for inclusion will be subject to the following rights terms, expressly
accepted in a signed contribution agreement. They cover code, documentation,
tests, designs and other original material intentionally submitted for inclusion
(the Contribution), identified by repository, PR and commit hashes in the acceptance
record. They do not cover unrelated work, ordinary discussion or bug reports.
A patch offered through an issue or review for inclusion needs the same acceptance.

The proposed agreement will contain these grants, effective upon valid execution
for the identified Contribution:

1. **Assignment.** You hereby assign to the Company all transferable copyright,
   database rights and design rights that you own in your original Contribution,
   worldwide for their full duration, including extensions and renewals, to the
   extent permitted by applicable law. Patents are licensed below, not assigned.
   This does not transfer your unrelated inventions, background materials,
   trademarks or third-party rights. You will reasonably assist with additional
   transfer documents required by law, at the Company's expense.
2. **Independent licence and fallback.** Whether or not the assignment is valid,
   you grant the Company a worldwide, non-exclusive, royalty-free, fully paid-up
   licence for the full duration of the rights you can license in the Contribution
   to use, reproduce, incorporate, modify, make derivative works, display, perform,
   distribute and commercialize it in any medium. The Company may transfer this
   licence and sublicense it through multiple tiers, including under different
   open-source, source-available or proprietary/commercial terms. This licence is
   irrevocable to the extent permitted by law and applies independently if an
   assignment is ineffective or a right cannot be assigned but can be licensed.
3. **Patents.** You grant the Company and recipients of software incorporating the
   Contribution a worldwide, non-exclusive, royalty-free, fully paid-up patent
   licence for the patent term, irrevocable to the extent permitted by law, to
   make, have made, use, offer for sale, sell, import and otherwise transfer that
   software. It covers only claims you own or can license that are necessarily
   infringed by your Contribution alone or in combination with the project as
   submitted. The Company may transfer and sublicense this grant through multiple
   tiers. It does not license unrelated patent claims or claims made necessary
   only by later modifications or combinations.
4. **Moral rights.** To the extent law allows, you waive and agree not to assert
   your moral rights in the Contribution against the Company or its licensees
   exercising these grants. Where waiver is unavailable but consent is permitted,
   you consent to the modifications, distribution and other uses described above.
   Rights that cannot lawfully be waived or made subject to such consent remain
   unaffected; no transfer of inalienable rights is claimed.
5. **Your authority.** You represent that you have legal capacity and own or are
   authorised by every relevant rights holder to make these grants; that they do
   not breach another agreement; and that, to your knowledge, your original
   material does not infringe others' rights. If an employer, client or co-author
   owns rights, obtain its written authorisation covering these exact grants or
   have its authorised representative sign before submission. Identify all such
   rights holders and permissions. Disclose any known restriction, claim or
   obligation that could prevent these grants; do not submit confidential material
   or material you lack authority to provide. No promise of maintenance or support
   is required.
6. **Third-party and background material.** Identify pre-existing material and
   its owners, sources, licences and notices separately. It is excluded from the
   assignment; no rights beyond those you can legally grant are claimed. State
   which background rights you can license under paragraph 2. Third-party material
   offered only under its existing licence needs separate compatibility review
   before inclusion; that licence may prevent commercial relicensing. Do not
   represent it as wholly owned original work. Preserve required notices.
7. **Existing and mandatory rights.** These terms do not revoke licences already
   granted to recipients, change this repository's [LICENSE](./LICENSE), or remove
   third-party conditions. They do not retroactively assign earlier contributions.
   Nonwaivable statutory rights, including applicable termination rights, remain
   effective despite words such as "irrevocable" or "full duration" above.

The intended result is Company ownership where assignment is legally effective,
plus broad licensing and commercial relicensing authority over rights actually
granted. It is not a promise that the Company owns every part of the repository.
Unlike a licence-only CLA, a valid assignment changes ownership of the assigned
rights; contributors cannot assume they retain those rights. Counsel and the
Owner must settle any licence back to contributors before activation.

### Required acceptance before merge

External contribution intake remains **issues and feedback only** until this
process is approved and operational. Do not merge external patches while it is
pending. A PR, checkbox, commit sign-off or this Markdown notice alone is not
being treated as a completed assignment, and no CLA bot or required check is
claimed to be installed by this documentation change.

Before reopening contributions, the Owner and maintainers must:

1. Have counsel finalise the agreement: verify the Company's legal name,
   registration and address; applicable law and execution formalities;
   consideration, any contributor licence back, employer authority, patent scope,
   moral rights, statutory termination and jurisdiction-specific limits. Review
   the fallback licence independently; it cannot cure lack of authority or assent.
2. Provide a signed individual agreement and, where needed, a corporate agreement
   signed by an authorised representative. Use a counsel-approved electronic
   signature process or signed document; display the complete versioned terms
   before acceptance. Include each rights holder's legal identity, signing
   capacity, agreement version/hash, date, repository and covered PR/commit hashes,
   and disclosed exclusions. Both the contributor and Company retain a copy.
3. Keep verifiable acceptance and authority records with restricted access and a
   published privacy/retention policy. Recheck coverage for every PR and new commit,
   including co-authors and changes of employer or rights ownership. Obtain new
   acceptance for uncovered contributions or changed terms; never silently apply
   a later policy version to an earlier signature.
4. Install and require a failing-until-verified `contribution-agreement` status
   check on all merge targets. It must verify the current PR head against those
   records and block missing, stale or incomplete coverage. Until automation is
   independently tested, keep intake closed; a maintainer's manual review must
   also confirm third-party compatibility and any exceptions counsel approved.
   Do not execute contributor code in a privileged agreement-check workflow.

For questions before submission, open an issue without private legal documents.
Maintainers must provide the approved private signing route when intake opens.

## Licence of contributions

The repository's existing licences and notices continue to govern distributed
material. The proposed agreement would additionally permit the Company to release
covered contributions under other licences, including commercial terms, subject
to third-party and nonwaivable rights. Submission alone is not proof that those
additional rights or an assignment have been obtained.
