// Structured trial contract template — Local Surge 14-day trial.
// Source: Ben's paste 2026-05-25. Each clause has a stable id used to
// look up amendments by clause_reference and substitute the new text
// in place of the original when rendering.
//
// Placeholder variables (substituted at render time):
//   {{client_name}}            from contracts.client_name
//   {{client_signatory}}       same as client_name unless company set
//   {{fee_amount}}             from contracts.fee_amount_usd ($997 default)
//   {{project_period_days}}    from contracts.project_period_days (14 default)
//   {{start_date}}             contracts.start_date or "the Start Date"

export const TRIAL_TEMPLATE = {
  id: 'trial',
  contractType: 'trial',
  title: 'Local Surge — 14-day Trial',

  // CLIENT FORM section — the cover page key/value block + the signed
  // declarations beneath it.
  clientForm: {
    rows: [
      { label: 'Client, you, yours', value: '{{client_name}}' },
      { label: 'Opt Digital, we, us or our', value: 'Opt Digital Limited (NZBN: 9429052206474) Address: 9 Chews Lane, WLG  Email: ben@opt.co.nz' },
      { label: 'Start Date', value: 'The date this Client Form is signed by the Client.' },
      { label: 'Project Period', value: '{{project_period_days}} Days' },
      { label: 'Services', value: 'Opt Digital will provide the Client with the following Services:\n• Local SEO\n• Lead Tracking & Monitoring\n• Reputation Management\n• Done-for-you GMB Management\n• Keyword Research\n• AI Automation & Lead Tracking' },
      { label: 'Fees', value: '' },
      { label: 'Cancellation Fee', value: 'X' },
      { label: 'Payment Method', value: '${{fee_amount}}    [Collect through Stripe]' },
      { label: 'Direct Debit Request', value: 'X' },
      { label: 'Special Conditions', value: 'X' },
    ],
    declarations: [
      'This term of this Client Form and the Client Terms will commence on the Start Date and continue for the Project Period plus any additional period agreed by the Client and Opt Digital Limited in writing. By signing below, the Client and Opt Digital Limited agree to the terms and conditions of this Client Form and the Client Terms attached.',
      'You acknowledge and agree that while Opt Digital Limited’s Services are designed to maximise your chances of growing your business, and that subject to clause 4, Opt Digital Limited does not guarantee or represent that as a result of receiving the Services your business will achieve growth, acquire new clients or that the Services will meet your specific requirements.',
      'Opt Digital Limited is not a financial adviser, lawyer, or taxation agent and nothing in the Services is intended to be professional advice and should not be relied on as such. You should obtain specific financial, legal, or other professional advice before relying on the Services.',
      'If you choose Direct Debit as a payment method, you acknowledge and agree that you will need to enter into a separate Direct Debit Service Agreement with Opt Digital Limited’s payment partner, Stripe, via a Direct Debit Request Form that we will supply to you. You also authorise the payment partner to debit your credit card or bank account at the intervals and in the amounts specified in the Direct Debit Request Form on our behalf to fulfil your payment obligations under this agreement.',
      'You acknowledge that you have been given the option of choosing a Payment Method based on either periodic billing (ongoing direct debit) or pre-payment (lump-sum payment).',
    ],
    executionLine: 'Executed as an agreement on _________________ (insert date the final party signs this Client Form)',
  },

  preamble: {
    title: 'CLIENT TERMS',
    intro: 'These Client Terms, together with any Client Form (defined in clause 1), set out the agreement (this ‘Agreement’) under the terms of which Opt Digital Limited (NZBN: 9429052206474) (‘Opt Digital Limited’) provides Services (defined in clause 2) to you or the company which you represent (the ‘Client’).',
  },

  // Top-level clauses. Each has id, number, title, and either
  // `paragraphs` (flat list) or `sections` (sub-clauses like 2.1, 2.2).
  // Amendments target the clause `id` (e.g. "7.2") so the renderer can
  // substitute that entire clause body with the agreed amended text.
  clauses: [
    {
      id: '1', number: '1', title: 'CLIENT FORM, THIS AGREEMENT',
      paragraphs: [
        { label: '(a)', text: 'These Client Terms will apply to all the Client’s dealings with Opt Digital Limited, including being incorporated in all agreements, quotations, or orders under which Opt Digital Limited is to provide services to the Client (each a ‘Client Form’) together with any additional terms included in such Client Form (provided such additional terms are recorded in writing).' },
        { label: '(b)', text: 'The Client will be taken to have accepted this Agreement if the Client accepts a Client Form or orders, accepts, or pays for any services provided by Opt Digital Limited after receiving or becoming aware of this Agreement or these Client Terms.' },
        { label: '(c)', text: 'In the event of any inconsistency between these Client Terms and any Client Form, these Client Terms will prevail, except that any “Special Conditions” (being terms described as such in a Client Form) will prevail over these Client Terms to the extent of any inconsistency.' },
      ],
    },
    {
      id: '2', number: '2', title: 'SERVICES',
      sections: [
        {
          id: '2.1', number: '2.1', title: 'GENERALLY',
          paragraphs: [
            { label: '(a)', text: 'In consideration for the payment of the fees set out in the Client Form (Fees), Opt Digital Limited will provide the Client with the services set out in a Client Form (Services).' },
            { label: '(b)', text: 'Opt Digital Limited will provide the Services during the Work Times set out in a Client Form, and for any additional hours agreed in writing by the parties.' },
            { label: '(c)', text: 'Unless otherwise agreed in writing, Opt Digital Limited may, in its discretion:', children: [
              { label: '(i)', text: 'not commence work on any Services until the Client has paid any Fees or deposit payable in respect of such Services; and' },
              { label: '(ii)', text: 'withhold delivery of Services until the Client has paid an invoice in respect of any Services, including invoices for previous Services that have already been provided.' },
            ] },
          ],
        },
        {
          id: '2.2', number: '2.2', title: 'SERVICES',
          intro: 'The Client agrees that:',
          paragraphs: [
            { label: '(a)', text: 'the Client must make themselves available for a 1-on-1 call at the beginning of the Project Period, in which Opt Digital Limited will explain the SEO Service roadmap, and the materials and services that will be provided as part of the Services throughout the Project Period;' },
            { label: '(b)', text: 'during the Project Period, Opt Digital Limited will make themselves available to the Client for 1 phone call every week in which Opt Digital Limited representatives will answer specific questions the Client might have relating to the Services;' },
            { label: '(c)', text: 'the materials that Opt Digital Limited provides to the Client as part of the SEO Services will be made available to the Client in perpetuity, however, the Client will need to contact Opt Digital Limited to request a new copy of these materials if they are lost or inaccessible for whatever reason, and Opt Digital Limited will endeavour to provide those materials to the Client again within 14 days; and' },
            { label: '(d)', text: 'the Client must make a reasonable effort to engage and attend the services provided by Opt Digital Limited as part of the SEO Services, including that the Client must:', children: [
              { label: '(i)', text: 'attend a minimum of 1 call monthly as described in clauses 2.2(b) and 2.2(c); and' },
              { label: '(ii)', text: 'implement all required actions recommended by Opt Digital Limited for search engine optimization strategies.' },
            ] },
          ],
        },
      ],
    },
    {
      id: '3', number: '3', title: 'DISCLAIMERS – NO LEGAL OR FINANCIAL ADVICE',
      paragraphs: [
        { label: '(a)', text: 'All information provided by Opt Digital Limited as part of the Services is general information.' },
        { label: '(b)', text: 'This information is based on information you provide to Opt Digital Limited.' },
        { label: '(c)', text: 'No information provided as part of the Services is intended to be legal or financial advice of any kind and should not be relied on as such.' },
        { label: '(d)', text: 'You should obtain specific financial, legal, or other professional advice before relying on the Services. By not seeking such advice, you accept the risk that the information provided as part of the Services may not meet the specific needs of your business.' },
      ],
    },
    {
      id: '4', number: '4', title: 'CONTINUATION OF PROJECT',
      paragraphs: [
        { label: '(a)', text: 'The initial fourteen (14) day trial period specified in the Client Form (Trial Period) is provided at the agreed trial fee.' },
        { label: '(b)', text: 'Unless the Client provides written notice of cancellation before the end of the Trial Period, the Client agrees that Services will automatically continue on an ongoing monthly basis at the agreed recurring service fee (currently USD $997 per month or such other amount agreed in writing), without the need for a new agreement.' },
        { label: '(c)', text: 'Upon continuation of Services, the Client authorises Opt Digital Limited to charge or debit the Client’s nominated Payment Method in accordance with clause 7 for each recurring billing cycle. This authority is continuing and does not require separate approval for each charge.' },
        { label: '(d)', text: 'Continuation of Services is conditional upon the Client having complied with all participation, communication, access, and payment obligations during the Trial Period.' },
        { label: '(e)', text: 'All Services provided after the Trial Period remain subject to the same terms and conditions of this Agreement.' },
        { label: '(f)', text: 'If the Client cancels before the end of the Trial Period, this Agreement will expire at the conclusion of the Trial Period, except for any outstanding fees and any clauses intended to survive termination.' },
        { label: '(g)', text: 'Following continuation of Services, the Client may cancel ongoing Services by providing no less than thirty (30) days written notice. Services will continue and fees remain payable during the notice period.' },
      ],
    },
    {
      id: '5', number: '5', title: 'CLIENT OBLIGATIONS',
      sections: [
        {
          id: '5.1', number: '5.1', title: 'PROVIDE INFORMATION AND LIAISON',
          paragraphs: [
            { label: '(a)', text: 'The Client must provide Opt Digital Limited with all documentation, information, and assistance reasonably required for Opt Digital Limited to perform the Services.' },
            { label: '(b)', text: 'The Client must provide to Opt Digital Limited all information reasonably required by Opt Digital Limited to assess and identify the specific actions and outcomes that the Client has taken and achieved throughout the Project Period.' },
            { label: '(c)', text: 'The Client agrees to liaise with Opt Digital Limited as it reasonably requests for the purpose of enabling Opt Digital Limited to provide the Services.' },
          ],
        },
        {
          id: '5.2', number: '5.2', title: 'COMPLIANCE WITH LAWS',
          intro: 'The Client warrants that it will not be receiving or requesting the Services, or during receiving or requesting the Services, or otherwise during any Project Period:',
          paragraphs: [
            { label: '(a)', text: 'breach any applicable laws, rules, and regulations (including any applicable privacy laws and any relevant industry codes) (Laws);' },
            { label: '(b)', text: 'do anything which may cause Opt Digital Limited to breach any Law;' },
            { label: '(c)', text: 'breach the direction of any government department or authority; or' },
            { label: '(d)', text: 'infringe the Intellectual Property Rights or other rights of any third party or breach any duty of confidentiality.' },
          ],
        },
      ],
    },
    {
      id: '6', number: '6', title: 'CLIENT MATERIALS',
      sections: [
        {
          id: '6.1', number: '6.1', title: 'CLIENT MATERIALS',
          paragraphs: [
            { text: 'The Client warrants that all information, documentation, and other Material (defined in clause 12) it provides to Opt Digital Limited for the purpose of receiving the Services, including financial records and information regarding its systems, procedures, and all other materials relating to compliance, is complete, accurate, and up-to-date.' },
          ],
        },
        {
          id: '6.2', number: '6.2', title: 'RELEASE',
          paragraphs: [
            { text: 'The Client releases Opt Digital Limited from all liability in relation to any loss or damage arising out of or in connection with the Services, to the extent such loss or damage is caused or contributed to by information, documentation, or any other Material provided by the Client being incomplete, inaccurate, or out-of-date.' },
          ],
        },
      ],
    },
    {
      id: '7', number: '7', title: 'PAYMENT',
      sections: [
        {
          id: '7.1', number: '7.1', title: 'FEES',
          paragraphs: [
            { text: 'The Client must pay to Opt Digital Limited fees in the amounts and at the times set out in the Client Form or as otherwise agreed in writing.' },
          ],
        },
        {
          id: '7.2', number: '7.2', title: 'PAYMENT AUTHORITY – CARD AND DIRECT DEBIT',
          intro: 'If the Client elects to pay by credit card, debit card, or bank direct debit (Payment Method), the Client:',
          paragraphs: [
            { label: '(a)', text: 'irrevocably authorises Opt Digital Limited, acting through its nominated payment processor (including Stripe), to store the Client’s nominated Payment Method and to charge or debit that Payment Method for all Fees payable under this Agreement when due;' },
            { label: '(b)', text: 'acknowledges that this authority is a continuing authority and applies to recurring, advance, variable, and one-off charges arising under this Agreement, including subscription fees, additional services, processing fees, dishonour fees, and outstanding balances;' },
            { label: '(c)', text: 'agrees that separate approval is not required for each charge, provided the charges are consistent with this Agreement or any agreed Client Form;' },
            { label: '(d)', text: 'consents to entering any payment processor direct debit or card authority forms required by Stripe, which operate in addition to and do not replace the authority granted under this Agreement;' },
            { label: '(e)', text: 'must ensure valid payment details and sufficient funds or credit availability at all times and notify Opt Digital Limited at least 48 hours before cancelling, restricting, or changing the nominated Payment Method;' },
            { label: '(f)', text: 'acknowledges that declined, reversed, or dishonoured payments may be retried and may incur a $7 dishonour fee plus any applicable processor fees, and Opt Digital Limited may suspend Services until payment is resolved.' },
          ],
        },
        {
          id: '7.3', number: '7.3', title: 'TIME FOR PAYMENT',
          intro: 'Unless otherwise agreed in the Client Form or in writing:',
          paragraphs: [
            { label: '(a)', text: 'if Opt Digital Limited issues an invoice to the Client, payment must be made by the time(s) specified in such invoice; and' },
            { label: '(b)', text: 'in all other circumstances, the Client must pay for goods and services within 3 days of receiving an invoice for amounts payable.' },
          ],
        },
        {
          id: '7.4', number: '7.4', title: 'PAYMENT METHOD',
          paragraphs: [
            { text: 'The Client must pay Fees using the fee payment method specified in the Client Form.' },
          ],
        },
        {
          id: '7.5', number: '7.5', title: 'ONLINE PAYMENT PARTNER',
          paragraphs: [
            { text: 'We use third-party payment providers (Payment Providers) to collect payments for Services, including Stripe and simpleinvoices.io. The processing of payments by the Payment Provider will be, in addition to these terms, subject to the terms, conditions, and privacy policies of the Payment Provider, and we are not liable for the security or performance of the Payment Provider. We reserve the right to correct, or to instruct our Payment Provider to correct, any errors or mistakes in collecting your payment.' },
          ],
        },
        {
          id: '7.6', number: '7.6', title: 'LATE PAYMENT',
          intro: 'If the Client does not pay an amount due under this Agreement on or before the date it is due:',
          paragraphs: [
            { label: '(a)', text: 'Opt Digital Limited may immediately cease providing the Services;' },
            { label: '(b)', text: 'Opt Digital Limited may seek to recover the amount due by referring the matter to a collection agency;' },
            { label: '(c)', text: 'without limiting any of Opt Digital Limited’s other rights under these terms, the Client must pay Opt Digital Limited interest at the rate of 20% per annum, on each amount outstanding, accruing daily and compounding monthly, from the due date for payment to the date on which payment is received by Opt Digital Limited; and' },
            { label: '(d)', text: 'the Client must reimburse Opt Digital Limited for any costs it incurs, including any legal costs, in recovering the amount due or enforcing any of its rights under this Agreement.' },
          ],
        },
        {
          id: '7.7', number: '7.7', title: 'GST',
          paragraphs: [
            { text: 'Unless otherwise indicated, amounts stated in a Client Form do not include GST. In relation to any GST payable for a taxable supply by Opt Digital Limited, the Client must pay the GST subject to Opt Digital Limited providing a tax invoice.' },
          ],
        },
        {
          id: '7.8', number: '7.8', title: 'CARD SURCHARGES',
          paragraphs: [
            { text: 'Opt Digital Limited reserves the right to charge credit card surcharges in the event payments are made using a credit, debit, or charge card (including Visa, MasterCard, or American Express).' },
          ],
        },
      ],
    },
    {
      id: '8', number: '8', title: 'CHANGES',
      paragraphs: [
        { label: '(a)', text: 'The Client must pay additional service fees for changes to Services requested by the Client which are outside the scope set out in the relevant Client Form (Changes).' },
        { label: '(b)', text: 'Unless otherwise agreed in writing, Opt Digital Limited may at its discretion extend or modify any delivery schedule or deadlines for the Services as may be reasonably required by such Changes.' },
      ],
    },
    {
      id: '9', number: '9', title: 'ACCREDITATIONS',
      intro: 'Unless otherwise agreed in writing:',
      paragraphs: [
        { label: '(a)', text: 'all displays or publications of any deliverables provided to the Client as part of the Services must, if requested by Opt Digital Limited, bear an accreditation and/or a copyright notice including Opt Digital Limited’s name in the form, size, and location as directed by Opt Digital Limited; and' },
        { label: '(b)', text: 'Opt Digital Limited retains the right to describe the Services and reproduce, publish, and display the deliverables in Opt Digital Limited’s portfolios and websites for the purposes of recognition or professional advancement, and to be credited with authorship of the Services and deliverables in connection with such uses.' },
      ],
    },
    {
      id: '10', number: '10', title: 'THIRD-PARTY GOODS AND SERVICES',
      paragraphs: [
        { label: '(a)', text: 'Any Service that requires Opt Digital Limited to acquire goods and services supplied by a third party on behalf of the Client may be subject to the terms & conditions of that third party (Third Party Terms), including ‘no refund’ policies.' },
        { label: '(b)', text: 'The Client agrees to any Third Party Terms applicable to any goods and services supplied by a third party that the Client or Opt Digital Limited acquires as part of the Services, and Opt Digital Limited will not be liable for any loss or damage suffered by the Client in connection with such Third Party Terms.' },
      ],
    },
    {
      id: '11', number: '11', title: 'CONFIDENTIALITY',
      paragraphs: [
        { label: '(a)', text: 'Except as contemplated by this Agreement, each party must not, and must not permit any of its officers, employees, agents, contractors, or related companies to, use or disclose to any person any confidential information disclosed to it by the other party without its prior written consent.' },
        { label: '(b)', text: 'This clause 11 does not apply to:', children: [
          { label: '(i)', text: 'information which is generally available to the public (other than as a result of a breach of this Agreement or another obligation of confidence);' },
          { label: '(ii)', text: 'information required to be disclosed by any law; or' },
          { label: '(iii)', text: 'information disclosed by Opt Digital Limited to its subcontractors, employees, or agents for the purposes of performing the Services or its obligations under this Agreement.' },
        ] },
      ],
    },
    {
      id: '12', number: '12', title: 'INTELLECTUAL PROPERTY',
      sections: [
        {
          id: '12.1', number: '12.1', title: 'CLIENT CONTENT',
          paragraphs: [
            { label: '(a)', text: 'The Client grants to Opt Digital Limited (and its subcontractors, employees, and agents) a non-exclusive, royalty-free, non-transferable, worldwide, and irrevocable licence to use the Client Content to the extent reasonably required to perform any part of the Services.' },
            { label: '(b)', text: 'The Client:', children: [
              { label: '(i)', text: 'warrants that Opt Digital Limited’s use of Client Content as contemplated by this Agreement will not infringe any third-party Intellectual Property Rights; and' },
              { label: '(ii)', text: 'will indemnify Opt Digital Limited from and against all losses, claims, expenses, damages, and liabilities (including any taxes, fees, or costs) which arise out of such infringement or a claim of such an infringement.' },
            ] },
          ],
        },
        {
          id: '12.2', number: '12.2', title: 'DEVELOPED IP',
          paragraphs: [
            { label: '(a)', text: 'All Developed IP will be solely and exclusively owned by Opt Digital Limited until the completion of the contract.' },
            { label: '(b)', text: 'Upon completion of the contract, Opt Digital Limited grants the Client full ownership of the Developed IP.' },
            { label: '(c)', text: 'Opt Digital Limited grants to the Client a non-exclusive, royalty-free, non-transferable, and revocable licence to use Developed IP to the extent required for the Client to use, enjoy the benefit of, or exploit the Services during the contract term.' },
          ],
        },
        {
          id: '12.3', number: '12.3', title: 'CONSULTANT IP',
          paragraphs: [
            { label: '(a)', text: 'Opt Digital Limited grants to the Client a non-exclusive, royalty-free, non-transferable, and revocable licence to use Opt Digital Limited IP to the extent required for the Client to use, enjoy the benefit of, or exploit the Services.' },
            { label: '(b)', text: 'Unless otherwise agreed in writing by Opt Digital Limited or in this clause 12.3, the Client will not acquire Intellectual Property Rights in any Opt Digital Limited IP under this Agreement or as part of receiving the Services.' },
          ],
        },
        {
          id: '12.4', number: '12.4', title: 'DEFINITIONS',
          intro: 'For the purposes of this Agreement:',
          paragraphs: [
            { label: '(a)', text: 'Client Content means any Material supplied by the Client to Opt Digital Limited under or in connection with this Agreement, including any Intellectual Property Rights attaching to that Material.' },
            { label: '(b)', text: 'Opt Digital Limited IP means all Material owned or licensed by Opt Digital Limited that is not Developed IP and any Intellectual Property Rights attaching to that Material.' },
            { label: '(c)', text: 'Developed IP means the Material produced by Opt Digital Limited in the course of providing the Services, either alone or in conjunction with the Client or others, and any Intellectual Property Rights attaching to that Material.' },
            { label: '(d)', text: 'Intellectual Property Rights means any and all present and future intellectual and industrial property rights throughout the world (whether registered or unregistered), including copyright, trademarks, designs, patents, moral rights, semiconductor and circuit layout rights, trade, business, company, and domain names, and other proprietary rights, trade secrets, know-how, technical data, confidential information, and the right to have information kept confidential, or any rights to registration of such rights (including renewal), whether created before or after the date of this Agreement.' },
            { label: '(e)', text: 'Material means tangible and intangible information, documents, reports, drawings, designs, software (including source and object code), inventions, concepts, data, and other materials in any media whatsoever.' },
          ],
        },
      ],
    },
    {
      id: '13', number: '13', title: 'WARRANTIES',
      paragraphs: [
        { label: '(a)', text: 'Subject to clause 4, to the maximum extent permitted by applicable law, all express or implied representations and warranties not expressly stated in this agreement are excluded.' },
        { label: '(b)', text: 'Nothing in this agreement is intended to limit the operation of New Zealand Consumer Law. Under the Fair Trading Act 1986 and the Consumer Guarantees Act 1993, the Client may be entitled to certain remedies (such as a refund, replacement, or repair) if there is a failure with the goods or services provided by Opt Digital Limited.' },
      ],
    },
    {
      id: '14', number: '14', title: 'LIABILITY',
      paragraphs: [
        { label: '(a)', text: 'Limitation of liability: To the maximum extent permitted by applicable law, the maximum aggregate liability of Opt Digital Limited to the Client in respect of loss or damage sustained by the Client under or in connection with this Agreement is limited to the total Fees paid to Opt Digital Limited by the Client in the 6 months preceding the first event giving rise to the relevant liability.' },
        { label: '(b)', text: 'Indemnity: The Client agrees at all times to indemnify and hold harmless Opt Digital Limited and its officers, employees, agents, and contractors (“those indemnified”) from and against any loss (including reasonable legal costs) or liability incurred or suffered by any of those indemnified where such loss or liability was caused or contributed to by the Client or the Client’s officers’, employees’, agents’, or contractors’: (i) breach of any term of this Agreement; or (ii) negligent, fraudulent, or criminal act or omission.' },
        { label: '(c)', text: 'Consequential loss: Opt Digital Limited will not be liable for any incidental, special, or consequential loss or damages, or damages for loss of data, business or business opportunity, goodwill, anticipated savings, profits, or revenue arising under or in connection with this Agreement or any goods or services provided by Opt Digital Limited, except to the extent this liability cannot be excluded under New Zealand law.' },
      ],
    },
    {
      id: '15', number: '15', title: 'SUBCONTRACTING',
      paragraphs: [
        { text: 'Opt Digital Limited may subcontract any aspect of providing the Services and the Client hereby consents to such subcontracting.' },
      ],
    },
    {
      id: '16', number: '16', title: 'TERMINATION',
      sections: [
        {
          id: '16.1', number: '16.1', title: 'TERMINATION BY OPT DIGITAL LIMITED',
          intro: 'Opt Digital Limited may terminate this Agreement in whole or in part immediately by written notice to the Client if:',
          paragraphs: [
            { label: '(a)', text: 'the Client is in breach of any term of this Agreement; or' },
            { label: '(b)', text: 'the Client becomes subject to any form of insolvency or bankruptcy administration.' },
          ],
        },
        {
          id: '16.2', number: '16.2', title: 'TERMINATION BY THE CLIENT',
          intro: 'The Client may terminate this Agreement in whole or in part by written notice to Opt Digital Limited if Opt Digital Limited:',
          paragraphs: [
            { label: '(a)', text: 'has committed a material breach of this Agreement and has failed to remedy the breach within 30 days after receiving written notice from the Client; or' },
            { label: '(b)', text: 'consents to such termination, subject to the Client’s fulfilment of any pre-conditions to such consent (for example, payment of a pro-rata portion of the agreed fees).' },
          ],
        },
        {
          id: '16.3', number: '16.3', title: 'EFFECT OF TERMINATION',
          intro: 'Upon termination of this Agreement, the Client must promptly pay (at Opt Digital Limited’s request):',
          paragraphs: [
            { label: '(a)', text: 'the Cancellation Fee specified in the Client Form;' },
            { label: '(b)', text: 'any payments required by Opt Digital Limited to third-party suppliers or to discontinue their work;' },
            { label: '(c)', text: 'Opt Digital Limited’s standard fees in relation to work already performed; and/or' },
            { label: '(d)', text: 'an equitable amount by way of profit margin on the preceding items.' },
          ],
        },
        {
          id: '16.4', number: '16.4', title: 'SURVIVAL',
          paragraphs: [
            { text: 'Any clause that by its nature would reasonably be expected to be performed after the termination or expiry of this Agreement will survive and be enforceable after such termination or expiry.' },
          ],
        },
        {
          id: '16.5', number: '16.5', title: 'CANCELLATION NOTICE',
          paragraphs: [
            { label: '(a)', text: 'Following continuation of Services after the Trial Period, the Client may cancel ongoing Services by providing no less than thirty (30) days written notice to Opt Digital Limited.' },
            { label: '(b)', text: 'During the notice period, Services will continue and all Fees remain payable.' },
            { label: '(c)', text: 'Cancellation does not affect any outstanding invoices, accrued charges, or previously authorised payments.' },
            { label: '(d)', text: 'Payment authority under clause 7 remains valid until all amounts owing are paid in full.' },
          ],
        },
      ],
    },
    {
      id: '17', number: '17', title: 'DISPUTE RESOLUTION',
      paragraphs: [
        { label: '(a)', text: 'A party claiming that a dispute has arisen under or in connection with this agreement must not commence court proceedings arising from or relating to the dispute, other than a claim for urgent interlocutory relief, unless that party has complied with the requirements of this clause.' },
        { label: '(b)', text: 'A party that requires resolution of a dispute which arises under or in connection with this agreement must give the other party or parties to the dispute written notice containing reasonable details of the dispute and requiring its resolution under this clause.' },
        { label: '(c)', text: 'Once the dispute notice has been given, each party to the dispute must then use its best efforts to resolve the dispute in good faith. If the dispute is not resolved within a period of 14 days (or such other period as agreed by the parties in writing) after the date of the notice, any party to the dispute may take legal proceedings to resolve the dispute.' },
      ],
    },
    {
      id: '18', number: '18', title: 'NOTICES',
      paragraphs: [
        { label: '(a)', text: 'A notice or other communication to a party under this agreement must be:', children: [
          { label: '(i)', text: 'in writing and in English; and' },
          { label: '(ii)', text: 'delivered via email to the other party, to the email address specified in this agreement, or if no email address is specified in this agreement, then the email address most regularly used by the parties to correspond for the purposes of the subject matter of this agreement as at the date of this agreement (Email Address). The parties may update their Email Address by notice to the other party.' },
        ] },
        { label: '(b)', text: 'Unless the party sending the notice knows or reasonably ought to suspect that an email was not delivered to the other party’s Email Address, notice will be taken to be given:', children: [
          { label: '(i)', text: '24 hours after the email was sent, unless that falls on a Saturday, Sunday, or a public holiday in New Zealand, in which case the notice will be taken to be given on the next occurring Business Day in New Zealand; or' },
          { label: '(ii)', text: 'when replied to by the other party, whichever is earlier.' },
        ] },
      ],
    },
    {
      id: '19', number: '19', title: 'GENERAL',
      sections: [
        { id: '19.1', number: '19.1', title: 'GOVERNING LAW AND JURISDICTION', paragraphs: [
          { text: 'This agreement is governed by the law applying in New Zealand. Each party irrevocably submits to the exclusive jurisdiction of the courts of New Zealand and courts of appeal from them in respect of any proceedings arising out of or in connection with this agreement. Each party irrevocably waives any objection to the venue of any legal process on the basis that the process has been brought in an inconvenient forum.' },
        ] },
        { id: '19.2', number: '19.2', title: 'BUSINESS DAYS', paragraphs: [
          { text: 'If the day on which any act is to be done under this agreement is a day other than a Business Day, that act must be done on or by the immediately following Business Day except where this agreement expressly specifies otherwise.' },
        ] },
        { id: '19.3', number: '19.3', title: 'AMENDMENTS', paragraphs: [
          { text: 'This agreement may only be amended in accordance with a written agreement between the parties.' },
        ] },
        { id: '19.4', number: '19.4', title: 'WAIVER', paragraphs: [
          { text: 'No party to this agreement may rely on the words or conduct of any other party as a waiver of any right unless the waiver is in writing and signed by the party granting the waiver.' },
        ] },
        { id: '19.5', number: '19.5', title: 'SEVERANCE', paragraphs: [
          { text: 'Any term of this agreement which is wholly or partially void or unenforceable is severed to the extent that it is void or unenforceable. The validity and enforceability of the remainder of this agreement is not limited or otherwise affected.' },
        ] },
        { id: '19.6', number: '19.6', title: 'JOINT AND SEVERAL LIABILITY', paragraphs: [
          { text: 'An obligation or a liability assumed by, or a right conferred on, two or more persons binds or benefits them jointly and severally.' },
        ] },
        { id: '19.7', number: '19.7', title: 'ASSIGNMENT', paragraphs: [
          { text: 'A party cannot assign, novate, or otherwise transfer any of its rights or obligations under this agreement without the prior written consent of the other party.' },
        ] },
        { id: '19.8', number: '19.8', title: 'COUNTERPARTS', paragraphs: [
          { text: 'This agreement may be executed in any number of counterparts. Each counterpart constitutes an original of this agreement and all together constitute one agreement.' },
        ] },
        { id: '19.9', number: '19.9', title: 'COSTS', paragraphs: [
          { text: 'Except as otherwise provided in this agreement, each party must pay its own costs and expenses in connection with negotiating, preparing, executing, and performing this agreement.' },
        ] },
        { id: '19.10', number: '19.10', title: 'ENTIRE AGREEMENT', paragraphs: [
          { text: 'This agreement embodies the entire agreement between the parties and supersedes any prior negotiation, conduct, arrangement, understanding, or agreement, express or implied, in relation to the subject matter of this agreement.' },
        ] },
        { id: '19.11', number: '19.11', title: 'INTERPRETATION', paragraphs: [
          { label: '(a)', text: 'Words in the singular include the plural (and vice versa).' },
          { label: '(b)', text: 'Words indicating a gender include the corresponding words of any other gender.' },
          { label: '(c)', text: 'If a word or phrase is given a defined meaning, any other part of speech or grammatical form of that word or phrase has a corresponding meaning.' },
          { label: '(d)', text: 'A reference to a person includes an individual, corporation, authority, partnership, trust, and other entities.' },
          { label: '(e)', text: 'A reference to a party includes that party’s successors and permitted assigns.' },
          { label: '(f)', text: 'Headings and words in bold type are for convenience only and do not affect interpretation.' },
          { label: '(g)', text: 'The word “includes” and similar words in any form are not words of limitation.' },
          { label: '(h)', text: 'A reference to $, or “dollar,” is to United States Dollars, unless otherwise agreed in writing.' },
        ] },
      ],
    },
  ],
}

export default TRIAL_TEMPLATE
