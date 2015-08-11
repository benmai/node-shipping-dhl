var builder = require('xmlbuilder'),
    extend  = require('extend'),
    https   = require('https'),
    moment  = require('moment'),
    parser  = require('xml2json'),
    path    = require('path');

var countryCodesToNames = (function (countryCodesArray) {
  countryCodesObject = {};
  countryCodesArray.forEach(function (country) {
    countryCodesObject[country.Code] = country.Name;
  });
  return countryCodesObject;
})(require('./country_codes.json'));

function DHL (options) {
  var self = this;
  self.hosts = {
    staging: 'xmlpitest-ea.dhl.com',
    live: 'xmlpi-ea.dhl.com'
  };
  self.path = 'XMLShippingServlet';

  var defaults = {
    mode:          'staging',
    system:        'metric', // alternatively, 'imperial'
    userAgent:     'node-shipping-dhl',
    debug:         true,
    accountNumber: ''
  };

  var requiredParameters = ['siteId', 'password']

  self.config = function (options) {
    if (!options) {
      throw new Error("must specify options");
    };
    for (var i = 0; i < requiredParameters.length; i++) {
      var requiredParameterName = requiredParameters[i]
      if (!options[requiredParameterName]) {
        throw new Error("must specify " + requiredParameterName);
      }
    }

    self.options = extend(defaults, options);
    return self;
  }
  /**
   * @param {String}   body data to send via POST to DHL
   * @param {Function} callback function to call on error or return
   *                   of data from DHL
   */
  function postToDHL (body, callback) {
    var request = https.request({
      host: self.hosts[self.options.mode],
      path: self.path,
      method: 'POST',
      headers: {
        'Content-Length': body.length,
        'Content-Type':   'text/xml',
        'User-Agent':     self.options.userAgent
      }
    });

    request.write(body);

    request.on('error', function (error) {
      callback(error, null);
    });

    request.on('response', function (response) {
      var responseData = '';

      response.on('data', function (data) {
        responseData += data.toString();
      });

      response.on('end', function () {
        var json;
        try {
          json = parser.toJson(responseData, {object: true});
        } catch (e) {
          if (self.options.debug) {
            console.log(e);
          }
          callback(new Error("unable to parse response into json"), null);
        }
        callback(null, json);
      });
    });

    request.end();
  }

  // ----- Helpers ------
  var xmlDateFormat     = "YYYY-MM-DD",
      xmlDateTimeFormat = "YYYY-MM-DDThh:mm:ss";

  /**
   * @returns the authentication object to put at the top of the xml requests
   */
  function buildAuthenticationObject () {
    return {
      ServiceHeader: {
        MessageTime: moment().format(xmlDateTimeFormat),
          // TODO ??
          MessageReference: '3141516171819202122555232444',
          SiteID:           self.options.siteId,
          Password:         self.options.password//,
          // PaymentType: 'T'
      }
    }
  }

  function concatKeyValuePair (xml, key, value) {
    var pair = {};
    pair[key] = value;
    return xml.concat(pair);
  }

  function dimensionalWeight (parcel) {
    var width  = parcel.width,
        height = parcel.height,
        depth  = parcel.depth;
    if (typeof width !== 'number') {
      width = parseInt(width);
    }
    if (typeof height !== 'number') {
      height = parseInt(height);
    }
    if (typeof depth !== 'number') {
      depth = parseInt(depth);
    }
    // http://www.dhl.com/en/tools/volumetric_weight_express.html
    var volumentricDivisor = 5000;
    return width * height * depth / volumentricDivisor;
  }

  function buildRatesXML (data) {
    var xml =[];
    xml = concatKeyValuePair(xml, 'Request', buildAuthenticationObject());
    xml = concatKeyValuePair(xml, 'From', {
      CountryCode: data.sender.countryCode,
      Postalcode: data.sender.postalCode,
      City: data.sender.city
    });
    xml = concatKeyValuePair(xml, 'BkgDetails', {
      PaymentCountryCode: data.sender.countryCode,
      Date: moment().format(xmlDateFormat),
      // TODO make dynamic
      ReadyTime: 'PT3H',
      DimensionUnit: self.options.system === 'metric' ? 'CM' : 'IN',
      WeightUnit: self.options.system === 'metric' ? 'KG' : 'LB',
      NumberOfPieces: data.parcels.length,
      Pieces: data.parcels.map(function (parcel, index) {
        return {
          Piece: {
            PieceID: index + 1,
            Height:  parcel.height,
            Depth:   parcel.depth,
            Width:   parcel.width,
            Weight:  parcel.weight
          }
        }
      }),
      PaymentAccountNumber: self.options.accountNumber
    });
    xml = concatKeyValuePair(xml, 'To', {
      CountryCode: data.receiver.countryCode,
      Postalcode:  data.receiver.postalCode,
      City:        data.receiver.city
    });
    return xml;
  }

  function buildShipXML (data) {
    // TODO Case where address is more than one line
    var xml = [];
    xml = concatKeyValuePair(xml, 'Request', buildAuthenticationObject());
    xml = concatKeyValuePair(xml, 'RequestedPickupTime', 'N');
    xml = concatKeyValuePair(xml, 'NewShipper', 'Y');
    xml = concatKeyValuePair(xml, 'LanguageCode', 'en');
    xml = concatKeyValuePair(xml, 'PiecesEnabled', 'Y');
    xml = concatKeyValuePair(xml, 'Billing', {
      ShipperAccountNumber: self.options.accountNumber,
      ShippingPaymentType:  'S',
      BillingAccountNumber: self.options.accountNumber,
      DutyPaymentType:      'S',
      DutyAccountNumber:    self.options.accountNumber
    });
    xml = concatKeyValuePair(xml, 'Consignee', {
      CompanyName: data.receiver.companyName || data.receiver.name,
      AddressLine: data.receiver.address,
      City:        data.receiver.city,
      PostalCode:  data.receiver.postalCode,
      CountryCode: data.receiver.countryCode,
      CountryName: countryCodesToNames[data.receiver.countryCode],
      // FederalTaxId: 'R_FederalTaxID_12345',
      // StateTaxId:   'R_StateTaxID_1234567',
      Contact: {
        PersonName:     data.receiver.name,
        PhoneNumber:    data.receiver.phone,
        // PhoneExtension: '123',
        // FaxNumber:      '123',
        // Telex:          'String',
        // Email: {
        //   From:    'test@d.com',
        //   To:      'test1@d.com',
        //   cc:      'String',
        //   Subject: 'testing only',
        //   ReplyTo: 'String',
        //   Body:    'testing only'
        // }
      }
    });
    // xml = concatKeyValuePair(xml, 'Commodity', {
    //   CommodityCode: 1,
    //   CommodityName: 'cm'
    // });
    // xml = concatKeyValuePair(xml, 'Dutiable', {
    //   DeclaredValue:    '2000.00',
    //   DeclaredCurrency: 'USD',
    //   ScheduleB:        '3002905110',
    //   ExportLicense:    'D123456',
    //   ShipperEIN:       '1111111111',
    //   ShipperIDType:    'S',
    //   ConsigneeIDType:  'S',
    //   ImportLicense:    'Text',
    //   ConsigneeEIN:     'Text',
    //   TermsOfTrade:     'DDU'
    // });
    // xml = concatKeyValuePair(xml, 'ExportDeclaration', {
    //   InterConsignee:    'String',
    //   IsPartiesRelation: 'N',
    //   ECCN:              'EAR99',
    //   SignatureName:     'String',
    //   SignatureTitle:    'String',
    //   ExportReason:      'S',
    //   ExportReasonCode:  'P',
    //   SedNumber:         'FTSR',
    //   SedNumberType:     'F',
    //   MxStateCode:       'St',
    //   ExportLineItem: {
    //     LineNumber:   '200',
    //     Quantity:     '32',
    //     QuantityUnit: 'String',
    //     Description:  'String',
    //     Value:        '200',
    //     IsDomestic:   'Y',
    //     ScheduleB:    '3002905110',
    //     ECCN:         'EAR99',
    //     Weight: {
    //       Weight: '100.0',
    //       WeightUnit: 'L'
    //     },
    //     License: {
    //       LicenseNumber: 'D123456',
    //       ExpiryDate:    '2011-09-29'
    //     },
    //     LicenseSymbol: 'String'
    //   }
    // });
    // xml = concatKeyValuePair(xml, 'Reference', {
    //   ReferenceID:   'SHIPMENT REFERENCE US-UK 1234567890',
    //   ReferenceType: 'St'
    // });
    xml = concatKeyValuePair(xml, 'ShipmentDetails', {
      NumberOfPieces: data.parcels.length,
      Pieces: data.parcels.map(function (parcel, index) {
        return {
          Piece: {
            PieceID:     index + 1,
            PackageType: 'CP', // EE (express envelope) or OD (other DHL)
            Weight:      parcel.weight,
            // http://www.dhl.com/en/tools/volumetric_weight_express.html
            DimWeight:   dimensionalWeight(parcel),
            Width:       parcel.width,
            Height:      parcel.height,
            Depth:       parcel.depth
          }
        }
      }),
      // Add together weights from all parcels
      Weight: data.parcels.reduce(function (acc, curr) {
        return acc + parseFloat(curr.weight);
      }, 0),
      WeightUnit:        self.options.system === 'metric' ? 'K' : 'L',
      GlobalProductCode: 'D',
      LocalProductCode:  'D',
      Date:              moment().format(xmlDateFormat),
      Contents:          'FOR TESTING PURPOSE ONLY. PLEASE DO NOT SHIP. 123456789012345678901234567890123456789 STOP',
      DoorTo:            'DD',
      DimensionUnit:     self.options.system === 'metric' ? 'C': 'I',
      InsuredAmount:     '1000.00',
      PackageType:       'CP', // EE (express envelope) or OD (other DHL)
      IsDutiable:        'Y',
      CurrencyCode:      'USD'
    })
    xml = concatKeyValuePair(xml, 'Shipper', {
      ShipperID:         self.options.accountNumber,
      CompanyName:       data.sender.companyName,
      RegisteredAccount: self.options.accountNumber,
      // TODO multiple lines
      AddressLine:       data.sender.address,
      City:              data.sender.city,
      Division:          data.sender.province,
      DivisionCode:      data.sender.provinceCode,
      PostalCode:        data.sender.postalCode,
      CountryCode:       data.sender.countryCode,
      CountryName:       countryCodesToNames[data.sender.countryCode],
      // FederalTaxId:      'S_FederalTaxID_12345',
      // StateTaxId:        'S_StateTaxID_1234567',
      Contact: {
        PersonName:      data.sender.name,
        PhoneNumber:     data.sender.phone
        // Email: {
        //   From:    'ship@d.com',
        //   To:      'ship@d.com',
        //   cc:      'String',
        //   Subject: 'test only',
        //   ReplyTo: 'String',
        //   Body:    'test only'
        // }
      }
    });
    xml = concatKeyValuePair(xml, 'EProcShip', 'N')
    xml = concatKeyValuePair(xml, 'LabelImageFormat', 'PDF')

    return xml;
  }

  // Methods
  function rates (data, callback) {
    if (!callback) {
      throw new Error("no callback specified");
    }

    var body = builder.create({
      'p:DCTRequest': {
        "@xmlns:p":            "http://www.dhl.com",
        "@xmlns:p1":           "http://www.dhl.com/datatypes",
        "@xmlns:p2":           "http://www.dhl.com/DCTRequestdatatypes",
        "@xmlns:xsi":          "http://www.w3.org/2001/XMLSchema-instance",
        "@xsi:schemaLocation": "http://www.dhl.com DCT-req.xsd "
      }
    }).ele({
      GetQuote: buildRatesXML(data)
    });

    if (self.options.debug) {
      var pretty = body.end({pretty: true});
      console.log("Rates request XML:");
      console.log(pretty);
    }

    body = body.end();

    postToDHL(body, function (error, result){
      if (error) {
        callback(error, null);
      } else {
        var json = result['res:DCTResponse'].GetQuoteResponse;
        callback(null, json);
      }
    });
  }

  function ship (data, callback) {
    if (!callback) {
      throw new Error("no callback specified");
    }

    var body = builder.create({
      'req:ShipmentValidateRequest': {
        "@xmlns:req":          "http://www.dhl.com",
        "@xmlns:dhl":          "http://www.dhl.com/datatypes_global.xsd",
        "@xmlns:xsi":          "http://www.w3.org/2001/XMLSchema-instance",
        "@xsi:schemaLocation": "http://www.dhl.com ship-val-global-req.xsd"//,
        // "schemaVersion":      "1.0"
      }
    }).ele(buildShipXML(data));

    if (self.options.debug) {
      var pretty = body.end({pretty: true});
      console.log("Rates request XML:");
      console.log(pretty);
    }

    body = body.end();

    postToDHL(body, callback);
  }

  self.rates = rates;
  self.ship  = ship;

  return self.config(options);
}

module.exports = DHL;
