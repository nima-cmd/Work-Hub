/* 850 */
function preSavePage(options) {
  let orders = [];

  for (let m = 0; m < options.data.length; m++) {
    let d = options.data[m];
    let dates = {};
    let references = {};
    let items = [];

      for (let j = 0; j < d.message.transactionSets.length; j++) {
        let d1 = d.message.transactionSets[j];
        dates.poDate = convertToDate(d1.beginningSegmentForPurchaseOrder[0].date);

        // Get Reference Information
        if (d1.referenceInformation) {
          let internalVendorNoObj = d1.referenceInformation.find((dep) => {
            return dep.referenceIdentificationQualifier === 'IA';
          });

          if (internalVendorNoObj) {
            references.internalVendorNumber = internalVendorNoObj.referenceIdentification;
          }

          let departmentObj = d1.referenceInformation.find((dep) => {
            return dep.referenceIdentificationQualifier === 'DP';
          });

          if (departmentObj) {
            references.department = departmentObj.referenceIdentification;
          }

          let promotionDealNoObj = d1.referenceInformation.find((dep) => {
            return dep.referenceIdentificationQualifier === 'PD';
          });

          if (promotionDealNoObj) {
            references.promotionDealNo = promotionDealNoObj.referenceIdentification;

            if (promotionDealNoObj.description) {
              references.promotionDealNoDescription = promotionDealNoObj.description;
            }
          }

          let vendorTermsObj = d1.referenceInformation.find((dep) => {
            return dep.referenceIdentificationQualifier === 'TC';
          });

          if (vendorTermsObj) {
            references.vendorTerms = vendorTermsObj.referenceIdentification;

            if (vendorTermsObj.description) {
              references.vendorTermsDescription = vendorTermsObj.description;
            }
          }

          let merchTypeObj = d1.referenceInformation.find((dep) => {
            return dep.referenceIdentificationQualifier === 'MR';
          });

          if (merchTypeObj) {
            references.merchTypeCode = merchTypeObj.referenceIdentification;
          }

          let productSpecificationObj = d1.referenceInformation.find((dep) => {
            return dep.referenceIdentificationQualifier === 'QC';
          });

          if (productSpecificationObj) {
            references.productSpecification = productSpecificationObj.referenceIdentification;
          }
        }

        // Get Dates
        if (d1.dateTimeReference && d1.dateTimeReference[0]) {
          let shipNotBeforeDateObj = d1.dateTimeReference.find((date) => {
            return date.dateTimeQualifier === '037';
          });

          if (shipNotBeforeDateObj) {
            dates.shipNotBeforeDate = convertToDate(shipNotBeforeDateObj.date);
          }

          let cancelAfterDateObj = d1.dateTimeReference.find((date) => {
            return date.dateTimeQualifier === '001';
          });

          if (cancelAfterDateObj) {
            dates.cancelAfterDate = convertToDate(cancelAfterDateObj.date);
          }
        }

        // Items
        for (let k = 0; k < d1.PO1_loop.length; k++) {
          let d2 = d1.PO1_loop[k];

          let item = d2.baselineItemData[0];

          if (d2.PID_loop && d2.PID_loop[0] && d2.PID_loop[0].productItemDescription[0]) {
            item.productItemDescription = d2.PID_loop[0].productItemDescription[0];

            let productDescription = d2.PID_loop.find((p) => {
              return p.productItemDescription[0].productProcessCharacteristicCode === '08';
            });

            if (productDescription) {
              item.productDescription = productDescription.productItemDescription[0].description;
            }

            let vendorColorDescription = d2.PID_loop.find((p) => {
              return p.productItemDescription[0].productProcessCharacteristicCode === '73';
            });

            if (vendorColorDescription) {
              item.vendorColorDescription = vendorColorDescription.productItemDescription[0].description;
            }

            let vendorSizeDescription = d2.PID_loop.find((p) => {
              return p.productItemDescription[0].productProcessCharacteristicCode === '74';
            });

            if (vendorSizeDescription) {
              item.vendorSizeDescription = vendorSizeDescription.productItemDescription[0].description;
            }
          }

          if (d2.CTP_loop && d2.CTP_loop[0] && d2.CTP_loop[0].pricingInformation) {
            item.pricingInformation = d2.CTP_loop[0].pricingInformation[0]
          }

          if (d2.itemPhysicalDetails) {
            item.itemPhysicalDetails = d2.itemPhysicalDetails;
          }

          if (d2.SAC_loop) {
            item.allowancesOrCharges = d2.SAC_loop;
          }

          if (d2.N1_loop) {
            item.shipToID = d2.N1_loop[0].partyIdentification[0].name
          }

          // if (d2.destinationQuantity) {
          //   item.destinationQuantity = getStores(d2.destinationQuantity[0]);
          // }

          if (d2.destinationQuantity.length > 1) {
            let stores = [];
            d2.destinationQuantity.forEach((dq) => {
              stores = [...stores, ...getStores(dq)];
            });
            item.destinationQuantity = stores;
          } else {
            item.destinationQuantity = getStores(d2.destinationQuantity[0]);
          }


          items.push(item);
        }

        // Addresses
        for (let p = 0; p < d1.N1_loop.length; p++) {
          let d4 = d1.N1_loop[p];

          for (let r = 0; r < d4.partyIdentification.length; r++) {
            let d6 = d4.partyIdentification[r];

            // Ship From
            if (d6.entityIdentifierCode === 'TO') {
              d1.messageToIdentifierQualifier = d4.partyIdentification[0].identificationCodeQualifier;
              d1.messageToIdentifierCode = d4.partyIdentification[0].identificationCode;
            }

            // Ship From
            if (d6.entityIdentifierCode === 'SF') {
              d1.shipFrom = d6.name;
              d1.shipFromIdCodeQualifier = d4.partyIdentification[0].identificationCodeQualifier;
              d1.shipFromIdCode = d4.partyIdentification[0].identificationCode;
            }

            // Ship To
            if (d6.entityIdentifierCode === 'ST') {
              d1.shippingAddressee = d6.name

              if (d4.partyLocation && d4.partyLocation.length > 0) {
                d1.shippingAddress1 = d4.partyLocation[0].addressInformation
              }

              if (d4.partyIdentification && d4.partyIdentification.length > 0) {
                d1.shippingIdCodeQualifier = d4.partyIdentification[0].identificationCodeQualifier;
                d1.shippingIdCode = d4.partyIdentification[0].identificationCode;
              }

              if (d4.geographicLocation && d4.geographicLocation.length > 0) {
                d1.shippingCity = d4.geographicLocation[0].cityName;
                d1.shippingState = d4.geographicLocation[0].stateOrProvinceCode;
                d1.shippingPostalCode = d4.geographicLocation[0].postalCode;
                d1.shippingCountryCode = d4.geographicLocation[0].countryCode;
              }
            }

            // Bill To
            if (d6.entityIdentifierCode === 'BT' || d6.entityIdentifierCode === 'BY') {
              d1.billingAddressee = d6.name;
              d1.billingIdCode = d4.partyIdentification[0].identificationCode;
              d1.billingIdCodeQualifier = d4.partyIdentification[0].identificationCodeQualifier;

              if (d4.partyLocation && d4.partyLocation.length > 0) {
                d1.billingAddress1 = d4.partyLocation[0].addressInformation;
              }

              if (d4.geographicLocation && d4.geographicLocation.length > 0) {
                d1.billingCity = d4.geographicLocation[0].cityName;
                d1.billingState = d4.geographicLocation[0].stateOrProvinceCode;
                d1.billingPostalCode = d4.geographicLocation[0].postalCode;
                d1.billingCountryCode = d4.geographicLocation[0].countryCode;
              }
            }

            if (d1.FOBRelatedInstructions) {
              var payment_method = d1.FOBRelatedInstructions[0].shipmentMethodOfPaymentCode
            }

            if (d1.carrierDetailsRoutingSequenceTransitTime) {
              var shipment_method = d1.carrierDetailsRoutingSequenceTransitTime[0].identificationCode;
              var routingSequenceCode = d1.carrierDetailsRoutingSequenceTransitTime[0].routingSequenceCode;
              var routing = d1.carrierDetailsRoutingSequenceTransitTime[0].routing;
            }
          }
        }

        orders.push({
          orderful: {
            sender: d.sender,
            receiver: d.receiver,
            orderfulID: d.id,
            deliveryID: d.delivery.id,
            documentType: d.type.name,
            stream: d.stream,
            url: `https://ui.orderful.com/transactions/${d.id}`
          },
          purchaseOrderNumber: d1.beginningSegmentForPurchaseOrder[0].purchaseOrderNumber,
          purchaseOrderTypeCode: d1.beginningSegmentForPurchaseOrder[0].purchaseOrderTypeCode ,
          dates,
          references,
          routingSequenceCode,
          routing,
          shipmentmethod: shipment_method,
          paymentmethod: payment_method,
          shippingAddressee: d1.shippingAddressee,
          shippingAddress1: d1.shippingAddress1,
          shippingCity: d1.shippingCity,
          shippingState: d1.shippingState,
          shippingPostalCode: d1.shippingPostalCode,
          shippingCountryCode: d1.shippingCountryCode,
          shippingIdCodeQualifier: d1.shippingIdCodeQualifier,
          shippingIdCode: d1.shippingIdCode,
          billingAddressee: d1.billingAddressee,
          billingAddress1: d1.billingAddress1,
          billingCity: d1.billingCity,
          billingState: d1.billingState,
          billingPostalCode: d1.billingPostalCode,
          billingCountryCode: d1.billingCountryCode,
          billingIdCodeQualifier: d1.billingIdCodeQualifier,
          billingIdCode: d1.billingIdCode,
          shipFromIdCode: d1.shipFromIdCode,
          shipFromIdCodeQualifier: d1.shipFromIdCodeQualifier,
          shipFrom: d1.shipFrom,
          messageToIdentifierCode: d1.messageToIdentifierCode,
          messageToIdentifierQualifier: d1.messageToIdentifierQualifier,
          termsInformation: d1.termsOfSaleDeferredTermsOfSale,
          FOBRelatedInstructions: d1.FOBRelatedInstructions,
          carrierDetails: d1.carrierDetailsRoutingSequenceTransitTime,
          items
        });
      }
  }

  const splittedOrders = splitByStore(orders);

  return {
    data: splittedOrders,
    errors: options.errors,
    abort: false,
    newErrorsAndRetryData: []
  };
}

const convertToDate = (inputDate) => {
  inputDate = inputDate.toString();

  const year = inputDate.slice(0, 4);
  const month = inputDate.slice(4, 6);
  const day = inputDate.slice(6, 8);

  return `${month}/${day}/${year}`;
}

function getStores(input) {
    let result = [];

    const addResult = (code, qty) => {
        if (code && qty !== undefined) {
          if (code.length === 4 && code.charAt(0) === '0') {
            code = code.slice(1, 4);
          }

            result.push({
                store: code,
                quantity: parseInt(qty)
            });
        }
    };

    if (input.identificationCode && input.quantity) {
        addResult(input.identificationCode, input.quantity);
    }

    for (let key in input) {
        if (key.startsWith('identificationCode')) {
            let index = key.match(/\d+$/);

            if (index) {
                let quantityKey = `quantity${index}`;
                let quantity = input[quantityKey];
                let code = input[key];

                addResult(code, quantity);
            }
        }
    }

    return result;
}

function splitByStore(data) {
    const storeMap = {};

    data.forEach((d) => {
        d.items.forEach((item) => {
            item.destinationQuantity.forEach(destination => {
                let store = destination.store;

                if (store.length === 4 && store.charAt(0) === '0') {
                  store = store.slice(1, 4);
                }

                if (!storeMap[store]) {
                    storeMap[store] = JSON.parse(JSON.stringify(d));
                    storeMap[store].store = store;

                    storeMap[store].items = [];
                }

                // Crear una copia del ítem para este store
                const itemCopy = { ...item };
                itemCopy.destinationQuantity = [destination];

                // Agregar la copia del ítem a la entrada del store correspondiente
                storeMap[store].items.push(itemCopy);
            });
        });
    });

    return Object.values(storeMap);
}
