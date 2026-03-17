javascript
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const nodemailer = require('nodemailer');

const app = express();
app.use(express.json());
app.use(cors({
  origin: 'https://ginger.ind.br'
}));

const SYSTEM_PROMPT = `Você é o agente de atendimento da Ginger Fragrance Design, uma casa de fragrâncias estratégica brasileira, B2B, focada em transformar fragrância em ativo de negócio para indústrias de HPPC, Saneantes, Home Care e Pet Care.
